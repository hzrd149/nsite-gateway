import { assertEquals } from "jsr:@std/assert@^1.0.15";
import { cacheManifestEvent, getNsiteBlob } from "../helpers/events.ts";
import { shortId } from "../helpers/format.ts";
import { getManifestLogDetails } from "../helpers/manifest-log.ts";
import { manifestPaths, pathBlobs, siteManifests } from "../services/cache.ts";

function createManifestEvent(overrides: {
  id?: string;
  pubkey?: string;
  created_at?: number;
  identifier?: string;
} = {}) {
  const identifier = overrides.identifier ?? "";

  return {
    id: overrides.id ?? "f".repeat(64),
    kind: identifier === "" ? 15128 : 35128,
    pubkey: overrides.pubkey ?? "a".repeat(64),
    created_at: overrides.created_at ?? 1_700_000_000,
    content: "",
    sig: "b".repeat(128),
    tags: [
      ...(identifier === "" ? [] : [["d", identifier]]),
      ["path", "index.html", "c".repeat(64)],
    ],
  };
}

Deno.test("getManifestLogDetails returns full discovery fields", () => {
  const event = createManifestEvent({
    id: "d".repeat(64),
    pubkey: "e".repeat(64),
    created_at: Math.floor(Date.now() / 1000) - 90,
    identifier: "demo",
  });

  assertEquals(getManifestLogDetails(event), {
    id: event.id,
    type: "named",
    identifier: "demo",
    pubkey: event.pubkey,
    age: "1m",
  });
});

Deno.test({
  name: "getNsiteBlob returns cached manifest hits with manifest id",
  permissions: { env: true },
  async fn() {
    const event = createManifestEvent();
    const siteKey = `${event.pubkey}:`;
    const pathKey = `${event.pubkey}::/index.html`;

    try {
      await cacheManifestEvent(event);

      const result = await getNsiteBlob(event.pubkey, "/index.html", [], "");

      assertEquals(result.kind, "hit");
      if (result.kind === "hit") {
        assertEquals(result.event.manifestId, event.id);
        assertEquals(
          shortId(result.event.manifestId || "", 12),
          shortId(event.id, 12),
        );
      }
    } finally {
      pathBlobs.delete(pathKey);
      manifestPaths.delete(siteKey);
      siteManifests.delete(siteKey);
    }
  },
});

Deno.test({
  name: "getNsiteBlob keeps root and named manifests isolated",
  permissions: { env: true },
  async fn() {
    const pubkey = "a".repeat(64);
    const rootEvent = createManifestEvent({
      id: "1".repeat(64),
      pubkey,
    });
    const namedEvent = createManifestEvent({
      id: "2".repeat(64),
      pubkey,
      identifier: "blog",
    });
    const rootSiteKey = `${pubkey}:`;
    const namedSiteKey = `${pubkey}:blog`;
    const rootPathKey = `${pubkey}::/index.html`;
    const namedPathKey = `${pubkey}:blog:/index.html`;

    try {
      await cacheManifestEvent(rootEvent);
      await cacheManifestEvent(namedEvent);

      const rootResult = await getNsiteBlob(pubkey, "/index.html", [], "");
      const namedResult = await getNsiteBlob(pubkey, "/index.html", [], "blog");

      assertEquals(rootResult.kind, "hit");
      assertEquals(namedResult.kind, "hit");

      if (rootResult.kind === "hit" && namedResult.kind === "hit") {
        assertEquals(rootResult.event.manifestId, rootEvent.id);
        assertEquals(namedResult.event.manifestId, namedEvent.id);
      }
    } finally {
      pathBlobs.delete(rootPathKey);
      pathBlobs.delete(namedPathKey);
      manifestPaths.delete(rootSiteKey);
      manifestPaths.delete(namedSiteKey);
      siteManifests.delete(rootSiteKey);
      siteManifests.delete(namedSiteKey);
    }
  },
});
