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
      ["client", "nsyte"],
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
  assertEquals(sites[0].client, "nsyte");
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

Deno.test("buildIndexedSites retains newest manifest regardless of arrival order", () => {
  const older = createEvent({
    id: "a".repeat(64),
    pubkey: "1".repeat(64),
    kind: 35128,
    created_at: 100,
    tags: [["d", "blog"], ["title", "Old"]],
  });
  const newer = createEvent({
    ...older,
    id: "b".repeat(64),
    created_at: 200,
    tags: [
      ["d", "blog"],
      ["title", "Current"],
      ["description", "Updated description"],
      ["client", "nsyte"],
      ["path", "/index.html", "hash"],
    ],
  });
  for (const events of [[older, newer], [newer, older]]) {
    const sites = buildIndexedSites(events);
    assertEquals(sites.length, 1);
    assertEquals(sites[0].manifestId, newer.id);
    assertEquals(sites[0].createdAt, 200);
    assertEquals(sites[0].title, "Current");
    assertEquals(sites[0].description, "Updated description");
    assertEquals(sites[0].client, "nsyte");
    assertEquals(sites[0].pathCount, 1);
  }
});

Deno.test("buildIndexedSites separates authors, identifiers, and root sites", () => {
  const events = [
    createEvent({
      id: "a".repeat(64),
      pubkey: "1".repeat(64),
      kind: 15128,
      created_at: 100,
      tags: [],
    }),
    createEvent({
      id: "b".repeat(64),
      pubkey: "1".repeat(64),
      kind: 35128,
      created_at: 200,
      tags: [["d", ""]],
    }),
    createEvent({
      id: "c".repeat(64),
      pubkey: "1".repeat(64),
      kind: 35128,
      created_at: 300,
      tags: [["d", "blog"]],
    }),
    createEvent({
      id: "d".repeat(64),
      pubkey: "2".repeat(64),
      kind: 35128,
      created_at: 400,
      tags: [["d", "blog"]],
    }),
  ];
  const sites = buildIndexedSites(events);
  assertEquals(
    sites.map((site) => site.manifestId),
    events.toReversed().map((e) => e.id),
  );
  assertEquals(new Set(sites.map((site) => site.key)).size, 4);
});

Deno.test("buildIndexedSites orders equal-age sites and snapshots deterministically", () => {
  const pubkey = "1".repeat(64);
  const site = createEvent({
    id: "c".repeat(64),
    pubkey,
    kind: 35128,
    created_at: 100,
    tags: [["d", "blog"]],
  });
  const snapshot = createEvent({
    id: "a".repeat(64),
    pubkey,
    kind: 5128,
    created_at: 90,
    tags: [["a", `35128:${pubkey}:blog`]],
  });
  const secondSnapshot = createEvent({ ...snapshot, id: "b".repeat(64) });
  const secondSite = createEvent({
    ...site,
    id: "d".repeat(64),
    tags: [["d", "another"]],
  });
  for (
    const events of [
      [site, secondSite, secondSnapshot, snapshot],
      [snapshot, secondSnapshot, secondSite, site],
    ]
  ) {
    const sites = buildIndexedSites(events);
    assertEquals(sites.map((entry) => entry.identifier), ["another", "blog"]);
    assertEquals(sites[1].snapshots.map((entry) => entry.id), [
      snapshot.id,
      secondSnapshot.id,
    ]);
  }
});
