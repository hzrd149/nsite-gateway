import { assertEquals } from "jsr:@std/assert";
import { finalizeEvent, type NostrEvent } from "applesauce-core/helpers";
import { of } from "rxjs";
import {
  eventStore,
  getManifest,
  isMatchingManifestEvent,
  pool,
  selectCurrentManifest,
  syncSiteManifests,
} from "./nostr.ts";

const PATH_HASH = "0".repeat(64);
const ALT_PK = "1".repeat(64);

function manifest(
  secret: Uint8Array,
  kind: number,
  createdAt: number,
  tags: string[][] = [],
  content = "",
): NostrEvent {
  return finalizeEvent({
    kind,
    created_at: createdAt,
    tags: [["path", "/index.html", PATH_HASH], ...tags],
    content,
  }, secret);
}

Deno.test("exact manifest validation enforces id, author, kind, and site form", () => {
  const event = manifest(new Uint8Array(32).fill(1), 15128, 100);
  assertEquals(
    isMatchingManifestEvent(event, {
      type: "event",
      id: event.id,
      author: event.pubkey,
      kind: 15128,
    }),
    true,
  );
  assertEquals(
    isMatchingManifestEvent(event, {
      type: "event",
      id: event.id,
      author: ALT_PK,
    }),
    false,
  );
  assertEquals(
    isMatchingManifestEvent(event, {
      type: "event",
      id: event.id,
      kind: 35128,
    }),
    false,
  );
  assertEquals(
    isMatchingManifestEvent(event, { type: "event", id: "2".repeat(64) }),
    false,
  );
  assertEquals(
    isMatchingManifestEvent(event, { type: "snapshot", id: event.id }),
    false,
  );

  const withD = manifest(new Uint8Array(32).fill(2), 15128, 100, [["d", ""]]);
  assertEquals(
    isMatchingManifestEvent(withD, { type: "event", id: withD.id }),
    false,
  );
  const named = manifest(new Uint8Array(32).fill(3), 35128, 100, [[
    "d",
    "blog",
  ]]);
  assertEquals(
    isMatchingManifestEvent(named, { type: "event", id: named.id }),
    true,
  );
  const duplicateD = manifest(new Uint8Array(32).fill(4), 35128, 100, [
    ["d", "blog"],
    ["d", "other"],
  ]);
  assertEquals(
    isMatchingManifestEvent(duplicateD, { type: "event", id: duplicateD.id }),
    false,
  );
});

Deno.test("current selection breaks timestamp ties by lowest event id", () => {
  const secret = new Uint8Array(32).fill(5);
  const first = manifest(secret, 15128, 100, [], "first");
  const second = manifest(secret, 15128, 100, [], "second");
  const expected = first.id < second.id ? first : second;
  assertEquals(
    selectCurrentManifest([first, second], {
      type: "replaceable",
      kind: 15128,
      pubkey: first.pubkey,
      identifier: "",
    }),
    expected,
  );
});

Deno.test("current selection does not revive an older valid root", () => {
  const secret = new Uint8Array(32).fill(6);
  const older = manifest(secret, 15128, 100);
  const newestWithD = manifest(secret, 15128, 200, [["d", "invalid-root"]]);
  const address = {
    type: "replaceable",
    kind: 15128,
    pubkey: older.pubkey,
    identifier: "",
  } as const;
  assertEquals(selectCurrentManifest([older, newestWithD], address), undefined);
});

Deno.test("current selection ignores invalid ids and signatures before ordering", () => {
  const secret = new Uint8Array(32).fill(7);
  const older = manifest(secret, 15128, 100);
  const invalidNewer = JSON.parse(
    JSON.stringify(manifest(secret, 15128, 200)),
  ) as NostrEvent;
  invalidNewer.content = "changed after signing";
  assertEquals(
    selectCurrentManifest([older, invalidNewer], {
      type: "replaceable",
      kind: 15128,
      pubkey: older.pubkey,
      identifier: "",
    }),
    older,
  );
});

Deno.test("exact replaceable events remain pinned after a newer event arrives", async () => {
  const secret = new Uint8Array(32).fill(8);
  const older = manifest(secret, 15128, 100, [], "older");
  const newer = manifest(secret, 15128, 200, [], "newer");
  const originalRequest = pool.request;
  pool.request = (() => of(newer, older)) as typeof pool.request;

  try {
    await syncSiteManifests(["wss://relay.example.com"]);
    assertEquals(
      await getManifest({ type: "event", id: older.id, kind: 15128 }),
      older,
    );
    assertEquals(
      await getManifest({
        type: "replaceable",
        kind: 15128,
        pubkey: older.pubkey,
        identifier: "",
      }),
      newer,
    );
  } finally {
    pool.request = originalRequest;
    eventStore.remove(older);
    eventStore.remove(newer);
  }
});
