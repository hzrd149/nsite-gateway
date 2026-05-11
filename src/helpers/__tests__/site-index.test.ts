import { assertEquals } from "jsr:@std/assert";
import type { NostrEvent } from "applesauce-core/helpers";
import { buildIndexedSites } from "../site-index.ts";

function createEvent(
  init:
    & Partial<NostrEvent>
    & Pick<NostrEvent, "id" | "pubkey" | "kind" | "created_at" | "tags">,
): NostrEvent {
  return {
    content: "",
    sig: "f".repeat(128),
    ...init,
  };
}

Deno.test("buildIndexedSites groups snapshots under their parent site", () => {
  const pubkey = "1".repeat(64);
  const site = createEvent({
    id: "a".repeat(64),
    pubkey,
    kind: 35128,
    created_at: 100,
    tags: [
      ["d", "blog"],
      ["title", "Blog"],
      ["path", "/index.html", "2".repeat(64)],
    ],
  });
  const olderSnapshot = createEvent({
    id: "b".repeat(64),
    pubkey,
    kind: 5128,
    created_at: 90,
    tags: [
      ["a", `35128:${pubkey}:blog`],
      ["title", "Blog v1"],
      ["path", "/index.html", "2".repeat(64)],
    ],
  });
  const newerSnapshot = createEvent({
    id: "c".repeat(64),
    pubkey,
    kind: 5128,
    created_at: 110,
    tags: [
      ["a", `35128:${pubkey}:blog`],
      ["title", "Blog v2"],
      ["path", "/index.html", "2".repeat(64)],
    ],
  });

  const sites = buildIndexedSites([site, olderSnapshot, newerSnapshot]);

  assertEquals(sites.length, 1);
  assertEquals(sites[0].snapshots.map((snapshot) => snapshot.id), [
    newerSnapshot.id,
    olderSnapshot.id,
  ]);
});

Deno.test("buildIndexedSites ignores orphan snapshots in site listing", () => {
  const pubkey = "1".repeat(64);
  const snapshot = createEvent({
    id: "d".repeat(64),
    pubkey,
    kind: 5128,
    created_at: 90,
    tags: [
      ["a", `35128:${pubkey}:blog`],
      ["path", "/index.html", "2".repeat(64)],
    ],
  });

  assertEquals(buildIndexedSites([snapshot]), []);
});
