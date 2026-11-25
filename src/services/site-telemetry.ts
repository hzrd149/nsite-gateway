import logger from "../helpers/debug.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import { cache } from "./cache.ts";

const log = logger.extend("telemetry");

/** Outcome of the last request the gateway served for a path */
export type ServeResult =
  /** Blob streamed from a server */
  | "served"
  /** Request path is not in the manifest */
  | "path-not-found"
  /** No blossom servers known for the site */
  | "no-servers"
  /** All servers failed to return the blob */
  | "unavailable";

export type ServeRecord = {
  /** HTTP status returned to the client */
  s: number;
  r: ServeResult;
  /** Hostname of the server that delivered the blob */
  h?: string;
  /** Unix ms */
  t: number;
};

export type ServeLog = Record<string, ServeRecord>;

/** Max paths remembered per site (KV values are limited to 64 KiB) */
const MAX_PATHS = 300;
const FLUSH_DELAY = 15_000;
const SERVE_LOG_TTL = 7 * 24 * 60 * 60 * 1000;

const logs = new Map<string, { key: Deno.KvKey; log: ServeLog }>();
const dirty = new Set<string>();
let flushTimer: number | undefined;

export function getServeLogKey(site: ResolvedSiteAddress): Deno.KvKey {
  return site.type === "snapshot"
    ? ["serve-log", "snapshot", site.id]
    : ["serve-log", site.pubkey, site.identifier];
}

function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function trim(serveLog: ServeLog): ServeLog {
  const entries = Object.entries(serveLog);
  if (entries.length <= MAX_PATHS) return serveLog;
  entries.sort((a, b) => b[1].t - a[1].t);
  return Object.fromEntries(entries.slice(0, MAX_PATHS));
}

/** Records the result of serving a path. In-memory; flushed to KV later. */
export function recordServe(
  site: ResolvedSiteAddress,
  path: string,
  result: { status: number; result: ServeResult; server?: string },
): void {
  const key = getServeLogKey(site);
  const id = JSON.stringify(key);
  let entry = logs.get(id);
  if (!entry) {
    entry = { key, log: {} };
    logs.set(id, entry);
  }
  entry.log[path.slice(0, 512)] = {
    s: result.status,
    r: result.result,
    h: hostnameOf(result.server),
    t: Date.now(),
  };
  if (Object.keys(entry.log).length > MAX_PATHS * 1.2) {
    entry.log = trim(entry.log);
  }
  dirty.add(id);
  flushTimer ??= setTimeout(() => void flushServeLogs(), FLUSH_DELAY);
}

/** Merges in-memory records into KV */
export async function flushServeLogs(): Promise<void> {
  flushTimer = undefined;
  const ids = [...dirty];
  dirty.clear();

  for (const id of ids) {
    const entry = logs.get(id);
    if (!entry) continue;
    try {
      const stored = await cache.get<ServeLog>(entry.key);
      const merged = trim({ ...(stored.value ?? {}), ...entry.log });
      await cache.set(entry.key, merged, { expireIn: SERVE_LOG_TTL });
      // Keep memory bounded: the merged copy now lives in KV
      logs.delete(id);
    } catch (error) {
      log("Failed to flush serve log", error);
    }
  }
}

/** Reads the serve log for a site (one KV read, plus unflushed records) */
export async function getServeLog(
  site: ResolvedSiteAddress,
): Promise<ServeLog> {
  const key = getServeLogKey(site);
  const stored = await cache.get<ServeLog>(key);
  const pendingLog = logs.get(JSON.stringify(key))?.log;
  return { ...(stored.value ?? {}), ...(pendingLog ?? {}) };
}

onShutdown(async () => {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  await flushServeLogs().catch(() => {});
});
