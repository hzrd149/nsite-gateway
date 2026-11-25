import logger from "../helpers/debug.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import {
  readServeLog,
  type ServeLogRow,
  serveLogSiteKey,
  upsertServeLog,
} from "../helpers/stats-store.ts";
import { statsDb } from "./stats-db.ts";

const log = logger.extend("telemetry");

/** Outcome of the last request the gateway served for a path */
export type ServeResult =
  /** Blob served from the verified local cache */
  | "served"
  /** Request path is not in the manifest */
  | "path-not-found"
  /** All servers failed to return the blob */
  | "unavailable";

export type ServeRecord = {
  /** HTTP status returned to the client */
  s: number;
  r: ServeResult;
  /** Hostname of the server that filled the cache, when this request did */
  h?: string;
  /** Unix ms */
  t: number;
  /** Times this path was served within the retention window */
  n?: number;
};

export type ServeLog = Record<string, ServeRecord>;

/** Max paths remembered per site */
export const SERVE_LOG_MAX_PATHS = 300;
const FLUSH_DELAY = 10_000;

/** Unflushed records per site key, with per-path counts since the last flush */
let pending = new Map<string, Map<string, ServeLogRow>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Records the result of serving a path. In-memory; flushed later. */
export function recordServe(
  site: ResolvedSiteAddress,
  path: string,
  result: { status: number; result: ServeResult; server?: string },
): void {
  const key = serveLogSiteKey(site);
  let paths = pending.get(key);
  if (!paths) {
    paths = new Map();
    pending.set(key, paths);
  }
  const trimmed = path.slice(0, 512);
  const previous = paths.get(trimmed);
  paths.set(trimmed, {
    path: trimmed,
    status: result.status,
    result: result.result,
    host: hostnameOf(result.server),
    at: Date.now(),
    count: (previous?.count ?? 0) + 1,
  });
  // Bound memory between flushes; the database trims to the newest paths
  if (paths.size > SERVE_LOG_MAX_PATHS * 2) flushServeLogs();
  flushTimer ??= setTimeout(flushServeLogs, FLUSH_DELAY);
}

/** Writes pending records to the stats database */
export function flushServeLogs(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  const batch = pending;
  pending = new Map();
  for (const [key, paths] of batch) {
    try {
      upsertServeLog(statsDb, key, [...paths.values()], SERVE_LOG_MAX_PATHS);
    } catch (error) {
      log("Failed to flush serve log", error);
    }
  }
}

function toRecord(row: ServeLogRow): ServeRecord {
  return {
    s: row.status,
    r: row.result as ServeResult,
    h: row.host,
    t: row.at,
    n: row.count,
  };
}

/** Reads the serve log for a site, including unflushed records */
export function getServeLog(site: ResolvedSiteAddress): Promise<ServeLog> {
  const key = serveLogSiteKey(site);
  const serveLog: ServeLog = {};
  for (const row of readServeLog(statsDb, key, SERVE_LOG_MAX_PATHS)) {
    serveLog[row.path] = toRecord(row);
  }
  for (const row of pending.get(key)?.values() ?? []) {
    const stored = serveLog[row.path];
    serveLog[row.path] = {
      ...toRecord(row),
      n: (stored?.n ?? 0) + row.count,
    };
  }
  return Promise.resolve(serveLog);
}

onShutdown(() => Promise.resolve(flushServeLogs()), "flush");
