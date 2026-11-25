import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSiteAddress } from "./resolved-site.ts";
import type { IndexedSite } from "./site-index.ts";

/**
 * Pure table access for the stats database. Every function takes the
 * database handle so tests can use an in-memory database.
 */

const DAY_MS = 86_400_000;

/** UTC day key, e.g. 2026-11-25 */
export function dayKey(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Returns the last `days` UTC day keys, oldest first */
export function lastDayKeys(days: number, now = Date.now()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY_MS));
  return keys;
}

/** Ordered schema migrations; index + 1 is the resulting `user_version` */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE site_daily (
    day TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    identifier TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    bot_views INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    not_found INTEGER NOT NULL DEFAULT 0,
    unavailable INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, pubkey, identifier)
  ) WITHOUT ROWID;

  CREATE TABLE site_totals (
    pubkey TEXT NOT NULL,
    identifier TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    bot_views INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    not_found INTEGER NOT NULL DEFAULT 0,
    unavailable INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (pubkey, identifier)
  ) WITHOUT ROWID;

  CREATE TABLE serve_log (
    site_key TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    result TEXT NOT NULL,
    host TEXT,
    at INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_key, path)
  ) WITHOUT ROWID;
  CREATE INDEX serve_log_at ON serve_log (site_key, at);

  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE counters_daily (
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, name)
  ) WITHOUT ROWID;

  CREATE TABLE directory_sites (
    key TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    identifier TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE profiles (
    pubkey TEXT PRIMARY KEY,
    name TEXT,
    checked_at INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

/** Applies pending schema migrations */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const version = row?.user_version ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

/** Runs `fn` inside a transaction, rolling back on error */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-site counters

export const SITE_COUNTER_FIELDS = [
  "views",
  "bot_views",
  "requests",
  "not_found",
  "unavailable",
] as const;
export type SiteCounterField = typeof SITE_COUNTER_FIELDS[number];
export type SiteCounters = Record<SiteCounterField, number>;

export type SiteDelta = {
  day: string;
  pubkey: string;
  identifier: string;
  counts: Partial<SiteCounters>;
};

export function emptySiteCounters(): SiteCounters {
  return {
    views: 0,
    bot_views: 0,
    requests: 0,
    not_found: 0,
    unavailable: 0,
  };
}

/** Adds counter deltas to the daily and all-time site tables */
export function applySiteDeltas(
  db: DatabaseSync,
  deltas: SiteDelta[],
  now = Date.now(),
): void {
  if (deltas.length === 0) return;
  const columns = SITE_COUNTER_FIELDS.join(", ");
  const placeholders = SITE_COUNTER_FIELDS.map(() => "?").join(", ");
  const sums = SITE_COUNTER_FIELDS.map((f) => `${f} = ${f} + excluded.${f}`)
    .join(", ");
  const daily = db.prepare(
    `INSERT INTO site_daily (day, pubkey, identifier, ${columns})
     VALUES (?, ?, ?, ${placeholders})
     ON CONFLICT (day, pubkey, identifier) DO UPDATE SET ${sums}`,
  );
  const totals = db.prepare(
    `INSERT INTO site_totals
       (pubkey, identifier, ${columns}, first_seen_at, last_seen_at)
     VALUES (?, ?, ${placeholders}, ?, ?)
     ON CONFLICT (pubkey, identifier) DO UPDATE SET ${sums},
       last_seen_at = max(last_seen_at, excluded.last_seen_at)`,
  );
  transaction(db, () => {
    for (const { day, pubkey, identifier, counts } of deltas) {
      const values = SITE_COUNTER_FIELDS.map((f) => counts[f] ?? 0);
      daily.run(day, pubkey, identifier, ...values);
      totals.run(pubkey, identifier, ...values, now, now);
    }
  });
}

/**
 * Daily human views per site over the last `days` days, keyed by
 * `${pubkey}:${identifier}`, oldest day first and zero-filled.
 */
export function readDailyViews(
  db: DatabaseSync,
  days: number,
  now = Date.now(),
): Map<string, number[]> {
  const keys = lastDayKeys(days, now);
  const index = new Map(keys.map((key, i) => [key, i]));
  const rows = db.prepare(
    `SELECT day, pubkey, identifier, views FROM site_daily
     WHERE day >= ? AND day <= ? AND views > 0`,
  ).all(keys[0], keys[keys.length - 1]) as Array<
    { day: string; pubkey: string; identifier: string; views: number }
  >;

  const result = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.pubkey}:${row.identifier}`;
    let counts = result.get(key);
    if (!counts) {
      counts = new Array(days).fill(0);
      result.set(key, counts);
    }
    counts[index.get(row.day)!] += row.views;
  }
  return result;
}

export type SiteTotals = SiteCounters & {
  firstSeenAt?: number;
  lastSeenAt?: number;
};

/** All-time counters for one site (zeros when unknown) */
export function readSiteTotals(
  db: DatabaseSync,
  pubkey: string,
  identifier: string,
): SiteTotals {
  const row = db.prepare(
    `SELECT ${SITE_COUNTER_FIELDS.join(", ")}, first_seen_at, last_seen_at
     FROM site_totals WHERE pubkey = ? AND identifier = ?`,
  ).get(pubkey, identifier) as
    | (SiteCounters & { first_seen_at: number; last_seen_at: number })
    | undefined;
  if (!row) return emptySiteCounters();
  const totals: SiteTotals = emptySiteCounters();
  for (const field of SITE_COUNTER_FIELDS) totals[field] = row[field];
  totals.firstSeenAt = row.first_seen_at;
  totals.lastSeenAt = row.last_seen_at;
  return totals;
}

// ---------------------------------------------------------------------------
// Serve log

export type ServeLogRow = {
  path: string;
  status: number;
  result: string;
  host?: string;
  at: number;
  /** Times this path was served since the last flush */
  count: number;
};

/** Upserts serve records for a site and keeps only the `maxPaths` newest */
export function upsertServeLog(
  db: DatabaseSync,
  siteKey: string,
  rows: ServeLogRow[],
  maxPaths: number,
): void {
  if (rows.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO serve_log (site_key, path, status, result, host, at, count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_key, path) DO UPDATE SET
       status = excluded.status, result = excluded.result,
       host = excluded.host, at = excluded.at,
       count = count + excluded.count`,
  );
  const trim = db.prepare(
    `DELETE FROM serve_log WHERE site_key = ? AND path NOT IN (
       SELECT path FROM serve_log WHERE site_key = ?
       ORDER BY at DESC LIMIT ?)`,
  );
  transaction(db, () => {
    for (const row of rows) {
      upsert.run(
        siteKey,
        row.path,
        row.status,
        row.result,
        row.host ?? null,
        row.at,
        row.count,
      );
    }
    trim.run(siteKey, siteKey, maxPaths);
  });
}

/** Reads the newest `limit` serve records for a site */
export function readServeLog(
  db: DatabaseSync,
  siteKey: string,
  limit: number,
): ServeLogRow[] {
  const rows = db.prepare(
    `SELECT path, status, result, host, at, count FROM serve_log
     WHERE site_key = ? ORDER BY at DESC LIMIT ?`,
  ).all(siteKey, limit) as Array<ServeLogRow & { host: string | null }>;
  return rows.map((row) => ({ ...row, host: row.host ?? undefined }));
}

// ---------------------------------------------------------------------------
// Gateway counters

/** Adds deltas to the cumulative and daily counters */
export function addCounters(
  db: DatabaseSync,
  day: string,
  deltas: Map<string, number>,
): void {
  if (deltas.size === 0) return;
  const total = db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET value = value + excluded.value`,
  );
  const daily = db.prepare(
    `INSERT INTO counters_daily (day, name, value) VALUES (?, ?, ?)
     ON CONFLICT (day, name) DO UPDATE SET value = value + excluded.value`,
  );
  transaction(db, () => {
    for (const [name, value] of deltas) {
      if (value === 0) continue;
      total.run(name, value);
      daily.run(day, name, value);
    }
  });
}

/** Reads cumulative counters whose name starts with `prefix` */
export function readCounters(
  db: DatabaseSync,
  prefix = "",
): Record<string, number> {
  const rows = db.prepare(
    `SELECT name, value FROM counters
     WHERE substr(name, 1, ?) = ? ORDER BY name`,
  ).all(prefix.length, prefix) as Array<{ name: string; value: number }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.value]));
}

// ---------------------------------------------------------------------------
// Meta

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Sets a meta value only if it is missing; returns the stored value */
export function initMeta(db: DatabaseSync, key: string, value: string): string {
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
  return getMeta(db, key)!;
}

/** Adds to a numeric meta value; returns the new value */
export function addMetaNumber(
  db: DatabaseSync,
  key: string,
  delta: number,
): number {
  const next = (Number(getMeta(db, key)) || 0) + delta;
  setMeta(db, key, String(next));
  return next;
}

// ---------------------------------------------------------------------------
// Directory snapshot

/** Replaces the persisted directory site list */
export function replaceDirectorySites(
  db: DatabaseSync,
  sites: IndexedSite[],
  now = Date.now(),
): void {
  const insert = db.prepare(
    `INSERT INTO directory_sites (key, pubkey, identifier, data, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  transaction(db, () => {
    db.exec("DELETE FROM directory_sites");
    for (const site of sites) {
      insert.run(
        site.key,
        site.pubkey,
        site.identifier,
        JSON.stringify(site),
        now,
      );
    }
  });
}

/** Reads the persisted directory site list */
export function readDirectorySites(db: DatabaseSync): IndexedSite[] {
  const rows = db.prepare("SELECT data FROM directory_sites").all() as Array<
    { data: string }
  >;
  const sites: IndexedSite[] = [];
  for (const row of rows) {
    try {
      sites.push(JSON.parse(row.data));
    } catch {
      // Skip rows that no longer parse
    }
  }
  return sites;
}

/** Persisted sites whose keys are missing from `sites`, appended to it */
export function mergeDirectorySites(
  sites: IndexedSite[],
  persisted: IndexedSite[],
): IndexedSite[] {
  if (persisted.length === 0) return sites;
  const known = new Set(sites.map((site) => site.key));
  return [...sites, ...persisted.filter((site) => !known.has(site.key))];
}

// ---------------------------------------------------------------------------
// Profiles

export type ProfileRow = { pubkey: string; name?: string; checkedAt: number };

/** Upserts profile lookups; a missing name keeps the previously stored one */
export function upsertProfiles(db: DatabaseSync, rows: ProfileRow[]): void {
  if (rows.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO profiles (pubkey, name, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (pubkey) DO UPDATE SET
       name = coalesce(excluded.name, name),
       checked_at = max(checked_at, excluded.checked_at)`,
  );
  transaction(db, () => {
    for (const row of rows) {
      upsert.run(row.pubkey, row.name ?? null, row.checkedAt);
    }
  });
}

/** Reads every stored profile */
export function readProfiles(db: DatabaseSync): ProfileRow[] {
  const rows = db.prepare("SELECT pubkey, name, checked_at FROM profiles")
    .all() as Array<
      { pubkey: string; name: string | null; checked_at: number }
    >;
  return rows.map((row) => ({
    pubkey: row.pubkey,
    name: row.name ?? undefined,
    checkedAt: row.checked_at,
  }));
}

// ---------------------------------------------------------------------------
// Retention

/** Deletes daily rows and serve records older than `retentionDays` */
export function pruneStats(
  db: DatabaseSync,
  retentionDays: number,
  now = Date.now(),
): number {
  const cutoffDay = dayKey(now - retentionDays * DAY_MS);
  const cutoffTime = now - retentionDays * DAY_MS;
  return transaction(db, () => {
    let removed = 0;
    removed += Number(
      db.prepare("DELETE FROM site_daily WHERE day < ?").run(cutoffDay)
        .changes,
    );
    removed += Number(
      db.prepare("DELETE FROM counters_daily WHERE day < ?").run(cutoffDay)
        .changes,
    );
    removed += Number(
      db.prepare("DELETE FROM serve_log WHERE at < ?").run(cutoffTime).changes,
    );
    return removed;
  });
}

// ---------------------------------------------------------------------------
// Legacy KV import

/** The subset of `Deno.Kv` needed to import legacy stats */
export type LegacyKv = {
  list<T>(selector: { prefix: Deno.KvKey }): AsyncIterable<Deno.KvEntry<T>>;
  delete(key: Deno.KvKey): Promise<void>;
};

type LegacyServeRecord = { s: number; r: string; h?: string; t: number };

/** Serve-log site key: `snapshot:<id>` or `<pubkey>:<identifier>` */
export function serveLogSiteKey(site: ResolvedSiteAddress): string {
  return site.type === "snapshot"
    ? `snapshot:${site.id}`
    : `${site.pubkey}:${site.identifier}`;
}

function kvNumber(value: unknown): number {
  // Deno.KvU64 (duck-typed: the class only exists with --unstable-kv)
  if (
    value && typeof value === "object" && "value" in value &&
    typeof value.value === "bigint"
  ) return Number(value.value);
  if (typeof value === "bigint" || typeof value === "number") {
    return Number(value);
  }
  return 0;
}

/**
 * Copies stats stored in the shared KV cache by earlier versions into the
 * stats database, then deletes them from KV. Runs once (tracked in `meta`).
 */
export async function importLegacyKvStats(
  db: DatabaseSync,
  kv: LegacyKv,
  maxPaths: number,
  now = Date.now(),
): Promise<{ totals: number; days: number; serveLogs: number } | undefined> {
  if (getMeta(db, "kv_migrated")) return undefined;

  const totals: Array<[Deno.KvKey, string, string, number]> = [];
  for await (const entry of kv.list<unknown>({ prefix: ["analytics"] })) {
    const [, pubkey, identifier] = entry.key as string[];
    totals.push([entry.key, pubkey, identifier, kvNumber(entry.value)]);
  }
  const days: Array<[Deno.KvKey, string, string, string, number]> = [];
  for await (const entry of kv.list<unknown>({ prefix: ["analytics-day"] })) {
    const [, day, pubkey, identifier] = entry.key as string[];
    days.push([entry.key, day, pubkey, identifier, kvNumber(entry.value)]);
  }
  const serveLogs: Array<[Deno.KvKey, string, ServeLogRow[]]> = [];
  for await (
    const entry of kv.list<Record<string, LegacyServeRecord>>({
      prefix: ["serve-log"],
    })
  ) {
    const [, a, b] = entry.key as string[];
    const siteKey = a === "snapshot" ? `snapshot:${b}` : `${a}:${b}`;
    const rows = Object.entries(entry.value ?? {}).map(([path, record]) => ({
      path,
      status: record.s,
      result: record.r,
      host: record.h,
      at: record.t,
      count: 0,
    }));
    serveLogs.push([entry.key, siteKey, rows]);
  }

  const insertTotal = db.prepare(
    `INSERT INTO site_totals (pubkey, identifier, views, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pubkey, identifier) DO UPDATE SET views = views + excluded.views`,
  );
  const insertDay = db.prepare(
    `INSERT INTO site_daily (day, pubkey, identifier, views) VALUES (?, ?, ?, ?)
     ON CONFLICT (day, pubkey, identifier) DO UPDATE SET views = views + excluded.views`,
  );
  transaction(db, () => {
    for (const [, pubkey, identifier, views] of totals) {
      insertTotal.run(pubkey, identifier, views, now, now);
    }
    for (const [, day, pubkey, identifier, views] of days) {
      insertDay.run(day, pubkey, identifier, views);
    }
  });
  for (const [, siteKey, rows] of serveLogs) {
    upsertServeLog(db, siteKey, rows, maxPaths);
  }
  setMeta(db, "kv_migrated", String(now));

  for (const [key] of totals) await kv.delete(key);
  for (const [key] of days) await kv.delete(key);
  for (const [key] of serveLogs) await kv.delete(key);

  return {
    totals: totals.length,
    days: days.length,
    serveLogs: serveLogs.length,
  };
}
