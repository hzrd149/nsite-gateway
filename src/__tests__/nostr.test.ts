import { assert, assertFalse } from "jsr:@std/assert@^1.0.15";
import { isMatchingManifestAddress } from "../services/nostr.ts";

const PUBKEY = "a".repeat(64);

function createManifestEvent(overrides: {
  kind?: number;
  pubkey?: string;
  identifier?: string;
} = {}) {
  const identifier = overrides.identifier ?? "";

  return {
    id: "f".repeat(64),
    kind: overrides.kind ?? (identifier === "" ? 15128 : 35128),
    pubkey: overrides.pubkey ?? PUBKEY,
    created_at: 1_700_000_000,
    content: "",
    sig: "b".repeat(128),
    tags: [
      ...(identifier === "" ? [] : [["d", identifier]]),
      ["path", "index.html", "c".repeat(64)],
    ],
  };
}

Deno.test("isMatchingManifestAddress matches root manifests", () => {
  assert(isMatchingManifestAddress(createManifestEvent(), PUBKEY, ""));
});

Deno.test("isMatchingManifestAddress rejects root manifests for named requests", () => {
  assertFalse(isMatchingManifestAddress(createManifestEvent(), PUBKEY, "blog"));
});

Deno.test("isMatchingManifestAddress rejects named manifests with the wrong identifier", () => {
  assertFalse(
    isMatchingManifestAddress(
      createManifestEvent({ identifier: "docs" }),
      PUBKEY,
      "blog",
    ),
  );
});

Deno.test("isMatchingManifestAddress rejects manifests from another pubkey", () => {
  assertFalse(
    isMatchingManifestAddress(
      createManifestEvent({ pubkey: "b".repeat(64), identifier: "blog" }),
      PUBKEY,
      "blog",
    ),
  );
});
