import { assertEquals } from "jsr:@std/assert";
import { npubEncode } from "applesauce-core/helpers";
import { buildDirectory } from "../directory.ts";
import type { IndexedSite } from "../site-index.ts";
import {
  MAX_QUERY_LENGTH,
  normalizeQuery,
  searchDirectory,
} from "../search.ts";

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
    pathCount: 1,
    manifestId: "e".repeat(64),
    createdAt,
    snapshots: [],
    ...extra,
  };
}

const alice = "a".repeat(64);
const bob = "b".repeat(64);

const directory = buildDirectory({
  version: 1,
  now: 0,
  sites: [
    site(alice, "blog", 100, { title: "Alice's Blog" }),
    site(alice, "moon", 200, {
      title: "Sun and moon alarms",
      description: "Android app",
    }),
    site(bob, "", 300, { title: "Honeymoon photos" }),
    site(bob, "notes", 50, { description: "my blog notes" }),
  ],
  profiles: new Map([[alice, { name: "Alice Liddell" }], [bob, {
    name: "Bob",
  }]]),
});

const keys = (q: string) =>
  searchDirectory(directory, q).sites.map((s) => s.identifier || s.title);

Deno.test("search ranks name prefix > word start > mid-word > description", () => {
  assertEquals(keys("moon"), ["moon", "Honeymoon photos"]);
  assertEquals(keys("blog"), ["blog", "notes"]);
});

Deno.test("search requires every word to match", () => {
  assertEquals(keys("moon android"), ["moon"]);
  assertEquals(keys("moon blog"), []);
});

Deno.test("search finds authors by name and npub prefix", () => {
  assertEquals(
    searchDirectory(directory, "liddell").authors.map((a) => a.pubkey),
    [alice],
  );
  const npub = npubEncode(bob);
  assertEquals(
    searchDirectory(directory, npub.slice(0, 12)).authors.map((a) => a.pubkey),
    [bob],
  );
  // Site search also matches the author's name
  assertEquals(keys("alice").length, 2);
});

Deno.test("normalizeQuery trims, lowercases and truncates", () => {
  assertEquals(normalizeQuery("  Hello   World "), "hello world");
  assertEquals(normalizeQuery("x".repeat(500)).length, MAX_QUERY_LENGTH);
  assertEquals(searchDirectory(directory, "   ").sites, []);
});
