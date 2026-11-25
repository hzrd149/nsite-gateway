import { assert, assertEquals } from "jsr:@std/assert";
import { buildDirectory, getHitsKey, sparkline } from "../directory.ts";
import type { IndexedSite } from "../site-index.ts";

function site(
  pubkey: string,
  identifier: string,
  createdAt: number,
  extra: Partial<IndexedSite> = {},
): IndexedSite {
  return {
    key: `${identifier ? 35128 : 15128}:${pubkey}:${identifier}`,
    pubkey,
    identifier,
    kind: identifier ? 35128 : 15128,
    pathCount: 3,
    manifestId: "e".repeat(64),
    createdAt,
    snapshots: [],
    ...extra,
  };
}

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);

Deno.test("buildDirectory sorts recent, trending and featured authors", () => {
  const dir = buildDirectory({
    version: 1,
    now: 0,
    sites: [
      site(alice, "", 100, { title: "Alice home" }),
      site(alice, "blog", 300),
      site(bob, "", 200, {
        snapshots: [{
          id: "f".repeat(64),
          pubkey: bob,
          createdAt: 400,
          pathCount: 1,
        }],
      }),
    ],
    dailyHits: new Map([
      [getHitsKey(alice, ""), [1, 1, 1, 1, 1, 1, 1]],
      [getHitsKey(bob, ""), [0, 0, 0, 0, 0, 0, 20]],
    ]),
    profiles: new Map([[alice, { name: "Alice" }]]),
  });

  // Bob's snapshot makes his site the most recently updated
  assertEquals(dir.recent.map((s) => s.pubkey + s.identifier), [
    bob,
    alice + "blog",
    alice,
  ]);
  // Sites with no visits are left out of trending
  assertEquals(dir.trending.map((s) => s.pubkey), [bob, alice]);
  assertEquals(dir.trending[0].recentHits, 20);
  assertEquals(dir.featuredAuthors.map((a) => a.pubkey), [bob, alice]);
  assertEquals(dir.authors.get(alice)?.label, "Alice");
  assertEquals(dir.authors.get(alice)?.siteKeys.length, 2);
  assertEquals(dir.stats, { sites: 3, authors: 2, snapshots: 1, clients: 0 });
  assertEquals(dir.sites.get(`15128:${alice}:`)?.label, "Alice home");
  assert(
    dir.sites.get(`35128:${alice}:blog`)?.statusPath.startsWith(
      "/status/naddr1",
    ),
  );
});

Deno.test("buildDirectory drops muted authors", () => {
  const dir = buildDirectory({
    version: 1,
    now: 0,
    sites: [site(alice, "", 1), site(carol, "", 2)],
    muted: new Set([carol]),
  });
  assertEquals([...dir.authors.keys()], [alice]);
  assertEquals(dir.stats.sites, 1);
});

Deno.test("sparkline scales to the max value", () => {
  assertEquals(sparkline([0, 0, 0]), "▁▁▁");
  assertEquals(sparkline([0, 7, 14]), "▁▅█");
});
