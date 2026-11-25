import type { MiddlewareHandler } from "@hono/hono";
import logger from "../helpers/debug.ts";
import type { RequestLogEnv } from "../helpers/request-log.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import {
  addCounters,
  addMetaNumber,
  dayKey,
  getMeta,
  initMeta,
  readCounters,
} from "../helpers/stats-store.ts";
import { verifiedBlobCache } from "./blossom.ts";
import { statsDb } from "./stats-db.ts";

const log = logger.extend("stats");

/** How often buffered counters are written to the stats database */
const FLUSH_INTERVAL = 10_000;

/** Cumulative blob cache metrics; the others are gauges and stay live-only */
const BLOB_COUNTERS = [
  "hits",
  "misses",
  "fills",
  "failures",
  "corrupt",
  "evictions",
  "rejected",
] as const;

let pending = new Map<string, number>();
/** Blob metric values already counted (the metrics start at zero per process) */
const blobSnapshot = Object.fromEntries(
  BLOB_COUNTERS.map((name) => [name, 0]),
);
let uptimeMark = Date.now();

/** Buffers a gateway counter increment. Never does I/O. */
export function incrementCounter(name: string, n = 1): void {
  pending.set(name, (pending.get(name) ?? 0) + n);
}

/** Adds blob cache metric deltas since the last call to the pending counters */
function collectBlobMetrics(): void {
  const metrics = verifiedBlobCache.metrics;
  for (const name of BLOB_COUNTERS) {
    const delta = metrics[name] - blobSnapshot[name];
    if (delta > 0) incrementCounter(`blob.${name}`, delta);
    blobSnapshot[name] = metrics[name];
  }
}

/** Writes buffered counters and accumulated uptime to the stats database */
export function flushCounters(): void {
  collectBlobMetrics();
  const batch = pending;
  pending = new Map();
  const now = Date.now();
  const uptime = Math.floor((now - uptimeMark) / 1000);
  uptimeMark += uptime * 1000;
  try {
    addCounters(statsDb, dayKey(now), batch);
    if (uptime > 0) addMetaNumber(statsDb, "total_uptime_s", uptime);
  } catch (error) {
    log("Failed to flush counters", error);
  }
}

/** Counts every response by status class and blob cache outcome */
export const requestStats: MiddlewareHandler<RequestLogEnv> = async (
  c,
  next,
) => {
  try {
    await next();
  } finally {
    incrementCounter("requests.total");
    incrementCounter(`requests.status.${Math.floor(c.res.status / 100)}xx`);
    const cache = c.get("blobObservation")?.cache;
    if (cache && cache !== "none") incrementCounter(`requests.cache.${cache}`);
  }
};

export type PersistentStats = {
  firstStartedAt?: string;
  /** Seconds the gateway has been running, summed across restarts */
  totalUptime: number;
  requests: Record<string, number>;
  blobCacheTotals: Record<string, number>;
};

function strip(prefix: string, counters: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(counters).map(([name, value]) => [
      name.slice(prefix.length),
      value,
    ]),
  );
}

function withPending(prefix: string): Record<string, number> {
  const counters = readCounters(statsDb, prefix);
  for (const [name, n] of pending) {
    if (name.startsWith(prefix)) counters[name] = (counters[name] ?? 0) + n;
  }
  return strip(prefix, counters);
}

/** Cumulative stats for /health, including unflushed values */
export function getPersistentStats(): PersistentStats {
  const firstStarted = getMeta(statsDb, "first_started_at");
  const blob = withPending("blob.");
  for (const name of BLOB_COUNTERS) {
    blob[name] = (blob[name] ?? 0) +
      verifiedBlobCache.metrics[name] - blobSnapshot[name];
  }
  return {
    firstStartedAt: firstStarted
      ? new Date(Number(firstStarted)).toISOString()
      : undefined,
    totalUptime: (Number(getMeta(statsDb, "total_uptime_s")) || 0) +
      Math.floor((Date.now() - uptimeMark) / 1000),
    requests: withPending("requests."),
    blobCacheTotals: blob,
  };
}

let flushTimer: ReturnType<typeof setInterval> | undefined;

/** Starts periodic counter flushes */
export function startStatsService(): void {
  if (flushTimer !== undefined) return;
  initMeta(statsDb, "first_started_at", String(Date.now()));
  flushTimer = setInterval(flushCounters, FLUSH_INTERVAL);
  onShutdown(() => {
    clearInterval(flushTimer);
    return Promise.resolve();
  });
  onShutdown(() => Promise.resolve(flushCounters()), "flush");
}
