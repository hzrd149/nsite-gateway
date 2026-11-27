import { assertEquals, assertThrows } from "jsr:@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { IndexedSite } from "../site-index.ts";
import {
  addCounters,
  addMetaNumber,
  applySiteDeltas,
  dayKey,
  getMeta,
  importLegacyKvStats,
  initMeta,
  type LegacyKv,
  mergeDirectorySites,
  migrate,
  pruneStats,
  readCounters,
  readDailyViews,
  readDirectorySites,
  readProfiles,
  readServeLog,
  readSiteTotals,
  replaceDirectorySites,
  upsertProfiles,
  upsertServeLog,
} from "../stats-store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12);

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function site(key: string, pubkey = "a".repeat(64)): IndexedSite {
  return {
    key,
    pubkey,
    identifier: key,
    kind: 35128,
    pathCount: 1,
    manifestId: key,
    createdAt: 1,
    snapshots: [],
  };
}

Deno.test("migrate is idempotent", () => {
  const db = open();
  migrate(db);
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  assertEquals(row.user_version, 1);
  db.close();
});

Deno.test("migrate refuses a database from a newer gateway", () => {
  const db = open();
  db.exec("PRAGMA user_version = 999");
  assertThrows(() => migrate(db), Error, "newer than this gateway supports");
  db.close();
});

Deno.test("site deltas accumulate in daily and total tables", () => {
  const db = open();
  applySiteDeltas(db, [
    { day: dayKey(NOW), pubkey: "p", identifier: "", counts: { views: 2 } },
    {
      day: dayKey(NOW - DAY),
      pubkey: "p",
      identifier: "",
      counts: { views: 1, bot_views: 3, requests: 5 },
    },
  ], NOW);
  applySiteDeltas(db, [
    {
      day: dayKey(NOW),
      pubkey: "p",
      identifier: "",
      counts: { views: 1, not_found: 1 },
    },
  ], NOW + 1);

  const totals = readSiteTotals(db, "p", "");
  assertEquals(totals.views, 4);
  assertEquals(totals.bot_views, 3);
  assertEquals(totals.requests, 5);
  assertEquals(totals.not_found, 1);
  assertEquals(totals.firstSeenAt, NOW);
  assertEquals(totals.lastSeenAt, NOW + 1);
  assertEquals(readSiteTotals(db, "missing", "").views, 0);

  // Oldest first, zero-filled, human views only
  assertEquals(readDailyViews(db, 3, NOW).get("p:"), [0, 1, 3]);
  db.close();
});

Deno.test("daily views ignore days outside the window", () => {
  const db = open();
  applySiteDeltas(db, [
    {
      day: dayKey(NOW - 10 * DAY),
      pubkey: "p",
      identifier: "x",
      counts: { views: 9 },
    },
    {
      day: dayKey(NOW + DAY),
      pubkey: "p",
      identifier: "x",
      counts: { views: 9 },
    },
  ], NOW);
  assertEquals(readDailyViews(db, 7, NOW).size, 0);
  db.close();
});

Deno.test("serve log upserts, counts and keeps the newest paths", () => {
  const db = open();
  upsertServeLog(db, "p:", [
    { path: "/a", status: 200, result: "served", at: 1, count: 1 },
    { path: "/b", status: 404, result: "path-not-found", at: 2, count: 2 },
    { path: "/c", status: 200, result: "served", host: "h", at: 3, count: 1 },
  ], 10);
  upsertServeLog(db, "p:", [
    { path: "/a", status: 502, result: "unavailable", at: 4, count: 1 },
  ], 2);

  const rows = readServeLog(db, "p:", 10);
  assertEquals(rows.map((row) => row.path), ["/a", "/c"]);
  assertEquals(rows[0].status, 502);
  assertEquals(rows[0].count, 2);
  assertEquals(rows[1].host, "h");
  db.close();
});

Deno.test("counters accumulate totals and daily values", () => {
  const db = open();
  addCounters(db, "2026-11-24", new Map([["requests.total", 2]]));
  addCounters(
    db,
    "2026-11-25",
    new Map([["requests.total", 3], ["blob.hits", 1], ["zero", 0]]),
  );
  assertEquals(readCounters(db, "requests."), { "requests.total": 5 });
  assertEquals(readCounters(db), { "blob.hits": 1, "requests.total": 5 });
  const daily = db.prepare("SELECT count(*) AS n FROM counters_daily")
    .get() as {
      n: number;
    };
  assertEquals(daily.n, 3);
  db.close();
});

Deno.test("meta helpers", () => {
  const db = open();
  assertEquals(getMeta(db, "x"), undefined);
  assertEquals(initMeta(db, "x", "1"), "1");
  assertEquals(initMeta(db, "x", "2"), "1");
  assertEquals(addMetaNumber(db, "n", 5), 5);
  assertEquals(addMetaNumber(db, "n", 2), 7);
  db.close();
});

Deno.test("directory snapshot replaces and merges", () => {
  const db = open();
  replaceDirectorySites(db, [site("a"), site("b")]);
  replaceDirectorySites(db, [site("b"), site("c")]);
  const persisted = readDirectorySites(db);
  assertEquals(persisted.map((s) => s.key).sort(), ["b", "c"]);

  const merged = mergeDirectorySites(
    [{ ...site("b"), title: "live" }],
    persisted,
  );
  assertEquals(merged.map((s) => s.key), ["b", "c"]);
  assertEquals(merged[0].title, "live");
  db.close();
});

Deno.test("profiles keep the last known name", () => {
  const db = open();
  upsertProfiles(db, [{ pubkey: "p", name: "Alice", checkedAt: 1 }]);
  upsertProfiles(db, [{ pubkey: "p", checkedAt: 5 }]);
  assertEquals(readProfiles(db), [{
    pubkey: "p",
    name: "Alice",
    checkedAt: 5,
  }]);
  db.close();
});

Deno.test("prune removes old daily rows and serve records", () => {
  const db = open();
  applySiteDeltas(db, [
    {
      day: dayKey(NOW - 40 * DAY),
      pubkey: "p",
      identifier: "",
      counts: { views: 1 },
    },
    { day: dayKey(NOW), pubkey: "p", identifier: "", counts: { views: 1 } },
  ], NOW);
  addCounters(db, dayKey(NOW - 40 * DAY), new Map([["c", 1]]));
  upsertServeLog(db, "p:", [
    {
      path: "/old",
      status: 200,
      result: "served",
      at: NOW - 40 * DAY,
      count: 1,
    },
    { path: "/new", status: 200, result: "served", at: NOW, count: 1 },
  ], 10);

  assertEquals(pruneStats(db, 30, NOW), 3);
  assertEquals(readSiteTotals(db, "p", "").views, 2);
  assertEquals(readCounters(db), { c: 1 });
  assertEquals(readServeLog(db, "p:", 10).map((r) => r.path), ["/new"]);
  db.close();
});

Deno.test("legacy KV stats are imported once and deleted", async () => {
  const db = open();
  const store = new Map<string, { key: Deno.KvKey; value: unknown }>([
    ["1", { key: ["analytics", "p", "blog"], value: { value: 7n } }],
    [
      "2",
      {
        key: ["analytics-day", "2026-11-24", "p", "blog"],
        value: { value: 3n },
      },
    ],
    [
      "3",
      {
        key: ["serve-log", "p", "blog"],
        value: { "/index.html": { s: 200, r: "served", t: 10 } },
      },
    ],
    [
      "4",
      {
        key: ["serve-log", "snapshot", "abc"],
        value: { "/x": { s: 404, r: "path-not-found", t: 11 } },
      },
    ],
    ["5", { key: ["dns", "example.com"], value: "keep" }],
  ]);
  const kv: LegacyKv = {
    async *list<T>({ prefix }: { prefix: Deno.KvKey }) {
      for (const { key, value } of store.values()) {
        if (prefix.every((part, i) => key[i] === part)) {
          yield { key, value: value as T, versionstamp: "0" };
        }
      }
    },
    delete(key) {
      for (const [id, entry] of store) {
        if (JSON.stringify(entry.key) === JSON.stringify(key)) store.delete(id);
      }
      return Promise.resolve();
    },
  };

  const result = await importLegacyKvStats(db, kv, 300, NOW);
  assertEquals(result, { totals: 1, days: 1, serveLogs: 2 });
  const imported = readSiteTotals(db, "p", "blog");
  assertEquals(imported.views, 7);
  // History before the import is unknown, so no "since" date is claimed
  assertEquals(imported.firstSeenAt, undefined);
  assertEquals(imported.lastSeenAt, undefined);
  assertEquals(
    readDailyViews(db, 2, Date.UTC(2026, 10, 25)).get("p:blog"),
    [3, 0],
  );
  assertEquals(readServeLog(db, "p:blog", 10)[0].path, "/index.html");
  assertEquals(readServeLog(db, "snapshot:abc", 10)[0].status, 404);
  assertEquals([...store.values()].map((e) => e.key), [["dns", "example.com"]]);

  assertEquals(await importLegacyKvStats(db, kv, 300, NOW), undefined);

  // Later activity sets last-seen but keeps first-seen unknown
  applySiteDeltas(db, [
    { day: dayKey(NOW), pubkey: "p", identifier: "blog", counts: { views: 1 } },
  ], NOW);
  assertEquals(readSiteTotals(db, "p", "blog").firstSeenAt, undefined);
  assertEquals(readSiteTotals(db, "p", "blog").lastSeenAt, NOW);
  db.close();
});
