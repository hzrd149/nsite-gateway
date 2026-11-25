import logger from "../helpers/debug.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import { cache } from "./cache.ts";

const log = logger.extend("analytics");

/** How long daily hit buckets are kept */
const DAILY_RETENTION_DAYS = 30;
/** How often buffered hits are written to KV */
const FLUSH_INTERVAL = 30_000;
/** Max mutations per KV atomic operation (Deno KV allows 1000) */
const MAX_MUTATIONS = 500;

/** Pending hits keyed by `${pubkey}:${identifier}` (day is captured at flush) */
let pending = new Map<
  string,
  { pubkey: string; identifier: string; n: number }
>();
let pendingDay = dayKey();

/** UTC day key, e.g. 2026-11-25 */
function dayKey(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Returns the last `days` UTC day keys, oldest first */
function lastDayKeys(days: number, now = Date.now()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(dayKey(now - i * 86_400_000));
  }
  return keys;
}

/** Record a page view for a site. Buffered in memory; never awaits I/O. */
export function incrementHitCount(pubkey: string, identifier: string) {
  const today = dayKey();
  if (today !== pendingDay) {
    // Day rolled over: flush yesterday's buffer under its own day
    void flushHits();
  }
  const key = `${pubkey}:${identifier}`;
  const entry = pending.get(key);
  if (entry) entry.n++;
  else pending.set(key, { pubkey, identifier, n: 1 });
}

/** Writes buffered hits to KV */
async function flushHits(): Promise<void> {
  if (pending.size === 0) {
    pendingDay = dayKey();
    return;
  }
  const batch = [...pending.values()];
  const day = pendingDay;
  pending = new Map();
  pendingDay = dayKey();

  for (let i = 0; i < batch.length; i += MAX_MUTATIONS / 2) {
    try {
      const op = cache.atomic();
      const chunk = batch.slice(i, i + MAX_MUTATIONS / 2);
      for (const { pubkey, identifier, n } of chunk) {
        op.sum(["analytics", pubkey, identifier], BigInt(n));
        op.sum(["analytics-day", day, pubkey, identifier], BigInt(n));
      }
      await op.commit();
    } catch (error) {
      log("Failed to flush hits", error);
    }
  }
}

/** Get the total all-time hit count for a site. */
export async function getHitCount(
  pubkey: string,
  identifier: string,
): Promise<number> {
  const entry = await cache.get<Deno.KvU64>(["analytics", pubkey, identifier]);
  return entry.value ? Number(entry.value) : 0;
}

/**
 * Reads daily hits for every site over the last `days` days.
 * Returns counts keyed by `${pubkey}:${identifier}`, oldest day first.
 * Only called by the background directory rebuild.
 */
export async function getDailyHits(
  days: number,
  now = Date.now(),
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  const keys = lastDayKeys(days, now);

  for (let d = 0; d < keys.length; d++) {
    const iter = cache.list<Deno.KvU64>({ prefix: ["analytics-day", keys[d]] });
    for await (const entry of iter) {
      const [, , pubkey, identifier] = entry.key as string[];
      const key = `${pubkey}:${identifier}`;
      let counts = result.get(key);
      if (!counts) {
        counts = new Array(days).fill(0);
        result.set(key, counts);
      }
      counts[d] += Number(entry.value.value);
    }
  }

  return result;
}

/** Deletes daily buckets older than the retention window */
async function pruneDailyHits(now = Date.now()): Promise<number> {
  const cutoff = dayKey(now - DAILY_RETENTION_DAYS * 86_400_000);
  let removed = 0;
  const iter = cache.list({
    start: ["analytics-day", ""],
    end: ["analytics-day", cutoff],
  });
  for await (const entry of iter) {
    await cache.delete(entry.key);
    removed++;
  }
  return removed;
}

let flushTimer: ReturnType<typeof setInterval> | undefined;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

/** Starts periodic flush and pruning of analytics */
export function startAnalyticsService(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setInterval(() => void flushHits(), FLUSH_INTERVAL);
  const prune = () =>
    pruneDailyHits()
      .then((n) => n > 0 && log(`Pruned ${n} old daily hit buckets`))
      .catch((error) => log("Failed to prune daily hits", error));
  void prune();
  pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);

  onShutdown(() => {
    clearInterval(flushTimer);
    clearInterval(pruneTimer);
    return Promise.resolve();
  });
  // Runs before the KV store closes in the "storage" phase
  onShutdown(() => flushHits(), "flush");
}
