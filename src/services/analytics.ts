import { STATS_RETENTION_DAYS } from "../env.ts";
import logger from "../helpers/debug.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import {
  applySiteDeltas,
  dayKey,
  importLegacyKvStats,
  pruneStats,
  readDailyViews,
  readSiteTotals,
  type SiteCounterField,
  type SiteCounters,
  type SiteDelta,
  type SiteTotals,
} from "../helpers/stats-store.ts";
import { cache } from "./cache.ts";
import { SERVE_LOG_MAX_PATHS } from "./site-telemetry.ts";
import { statsDb } from "./stats-db.ts";

const log = logger.extend("analytics");

/** How often buffered site counters are written to the stats database */
const FLUSH_INTERVAL = 10_000;
/** How often old daily rows are pruned */
const PRUNE_INTERVAL = 6 * 60 * 60 * 1000;

/** Pending counter deltas keyed by `${day}:${pubkey}:${identifier}` */
let pending = new Map<string, SiteDelta>();

/**
 * Records a site event (page view, bot view, file request, 404, failure).
 * Buffered in memory; never does I/O.
 */
export function recordSiteEvent(
  pubkey: string,
  identifier: string,
  field: SiteCounterField,
  n = 1,
): void {
  const day = dayKey();
  const key = `${day}:${pubkey}:${identifier}`;
  let entry = pending.get(key);
  if (!entry) {
    entry = { day, pubkey, identifier, counts: {} };
    pending.set(key, entry);
  }
  entry.counts[field] = (entry.counts[field] ?? 0) + n;
}

/** Record a human page view for a site */
export function incrementHitCount(pubkey: string, identifier: string) {
  recordSiteEvent(pubkey, identifier, "views");
}

/** Writes buffered site counters to the stats database */
export function flushSiteStats(): void {
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending = new Map();
  try {
    applySiteDeltas(statsDb, batch);
  } catch (error) {
    log("Failed to flush site stats", error);
  }
}

function pendingFor(pubkey: string, identifier: string): Partial<SiteCounters> {
  const sum: Partial<SiteCounters> = {};
  for (const entry of pending.values()) {
    if (entry.pubkey !== pubkey || entry.identifier !== identifier) continue;
    for (const [field, n] of Object.entries(entry.counts)) {
      const f = field as SiteCounterField;
      sum[f] = (sum[f] ?? 0) + (n ?? 0);
    }
  }
  return sum;
}

/** All-time counters for a site, including unflushed events */
export function getSiteTotals(pubkey: string, identifier: string): SiteTotals {
  const totals = readSiteTotals(statsDb, pubkey, identifier);
  for (const [field, n] of Object.entries(pendingFor(pubkey, identifier))) {
    totals[field as SiteCounterField] += n ?? 0;
  }
  return totals;
}

/** Get the total all-time human page views for a site. */
export function getHitCount(pubkey: string, identifier: string): number {
  return getSiteTotals(pubkey, identifier).views;
}

/**
 * Reads daily human page views for every site over the last `days` days.
 * Returns counts keyed by `${pubkey}:${identifier}`, oldest day first.
 */
export function getDailyHits(
  days: number,
  now = Date.now(),
): Map<string, number[]> {
  return readDailyViews(statsDb, days, now);
}

/** Imports stats written to the KV cache by earlier versions (runs once) */
async function importLegacyStats(): Promise<void> {
  try {
    const result = await importLegacyKvStats(
      statsDb,
      cache,
      SERVE_LOG_MAX_PATHS,
    );
    if (result) {
      log(
        `Imported legacy KV stats: ${result.totals} site totals, ${result.days} daily buckets, ${result.serveLogs} serve logs`,
      );
    }
  } catch (error) {
    log("Failed to import legacy KV stats", error);
  }
}

let flushTimer: ReturnType<typeof setInterval> | undefined;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

/** Starts periodic flush and pruning of analytics */
export async function startAnalyticsService(): Promise<void> {
  if (flushTimer !== undefined) return;
  flushTimer = setInterval(flushSiteStats, FLUSH_INTERVAL);
  const prune = () => {
    try {
      const n = pruneStats(statsDb, STATS_RETENTION_DAYS);
      if (n > 0) log(`Pruned ${n} old stats rows`);
    } catch (error) {
      log("Failed to prune stats", error);
    }
  };
  pruneTimer = setInterval(prune, PRUNE_INTERVAL);

  onShutdown(() => {
    clearInterval(flushTimer);
    clearInterval(pruneTimer);
    return Promise.resolve();
  });
  // Runs before the stats database closes in the "storage" phase
  onShutdown(() => Promise.resolve(flushSiteStats()), "flush");

  await importLegacyStats();
  prune();
}
