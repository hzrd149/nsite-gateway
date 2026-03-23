import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.15";
import type { NostrEvent } from "nostr-tools";
import { cacheManifestEvent } from "../helpers/events.ts";
import { manifestPaths, pathBlobs, siteManifests } from "../services/cache.ts";

function createManifestEvent(overrides: {
  id?: string;
  pubkey?: string;
  created_at?: number;
  identifier?: string;
  title?: string;
  description?: string;
  paths?: Array<[string, string]>;
} = {}): NostrEvent {
  const identifier = overrides.identifier ?? "";
  const paths = overrides.paths ?? [["index.html", "c".repeat(64)]];
  const tags: string[][] = [];

  if (identifier !== "") tags.push(["d", identifier]);
  if (overrides.title) tags.push(["title", overrides.title]);
  if (overrides.description) tags.push(["description", overrides.description]);
  for (const [path, sha] of paths) tags.push(["path", path, sha]);

  return {
    id: overrides.id ?? "f".repeat(64),
    kind: identifier === "" ? 15128 : 35128,
    pubkey: overrides.pubkey ?? "a".repeat(64),
    created_at: overrides.created_at ?? 1_700_000_000,
    content: "",
    sig: "b".repeat(128),
    tags,
  };
}

async function withStatusEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = {
    CACHE_BACKEND: Deno.env.get("CACHE_BACKEND"),
    CACHE_RELAYS: Deno.env.get("CACHE_RELAYS"),
    BLOSSOM_PROXY: Deno.env.get("BLOSSOM_PROXY"),
  };

  Deno.env.delete("PUBLIC_DOMAIN");
  Deno.env.set("CACHE_BACKEND", "in-memory");
  Deno.env.set("CACHE_RELAYS", "wss://cache.example");
  Deno.env.set("BLOSSOM_PROXY", "http://proxy.invalid");

  try {
    return await fn();
  } finally {
    if (previous.CACHE_BACKEND === undefined) Deno.env.delete("CACHE_BACKEND");
    else Deno.env.set("CACHE_BACKEND", previous.CACHE_BACKEND);

    if (previous.CACHE_RELAYS === undefined) Deno.env.delete("CACHE_RELAYS");
    else Deno.env.set("CACHE_RELAYS", previous.CACHE_RELAYS);

    if (previous.BLOSSOM_PROXY === undefined) Deno.env.delete("BLOSSOM_PROXY");
    else Deno.env.set("BLOSSOM_PROXY", previous.BLOSSOM_PROXY);
  }
}

async function loadStatusModule() {
  return await import(`../routes/status.ts?test=${crypto.randomUUID()}`);
}

async function loadServer() {
  return await import(`../server.ts?test=${crypto.randomUUID()}`);
}

async function withServerEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = {
    CACHE_BACKEND: Deno.env.get("CACHE_BACKEND"),
    CACHE_RELAYS: Deno.env.get("CACHE_RELAYS"),
    BLOSSOM_PROXY: Deno.env.get("BLOSSOM_PROXY"),
  };

  Deno.env.delete("PUBLIC_DOMAIN");
  Deno.env.set("CACHE_BACKEND", "in-memory");
  Deno.env.set("CACHE_RELAYS", "wss://cache.example");
  Deno.env.set("BLOSSOM_PROXY", "http://proxy.invalid");

  try {
    return await fn();
  } finally {
    if (previous.CACHE_BACKEND === undefined) Deno.env.delete("CACHE_BACKEND");
    else Deno.env.set("CACHE_BACKEND", previous.CACHE_BACKEND);

    if (previous.CACHE_RELAYS === undefined) Deno.env.delete("CACHE_RELAYS");
    else Deno.env.set("CACHE_RELAYS", previous.CACHE_RELAYS);

    if (previous.BLOSSOM_PROXY === undefined) Deno.env.delete("BLOSSOM_PROXY");
    else Deno.env.set("BLOSSOM_PROXY", previous.BLOSSOM_PROXY);
  }
}

function getEventIdentifier(event: NostrEvent): string {
  return event.kind === 15128
    ? ""
    : event.tags.find((tag) => tag[0] === "d" && tag[1] !== undefined)?.[1] ||
      "";
}

async function clearManifestCache(event: NostrEvent) {
  const identifier = getEventIdentifier(event);
  const siteKey = `${event.pubkey}:${identifier}`;
  for (const tag of event.tags) {
    if (tag[0] !== "path" || !tag[1]) continue;
    const path = `/${tag[1]}`;
    pathBlobs.delete(`${event.pubkey}:${identifier}:${path}`);
  }
  manifestPaths.delete(siteKey);
  siteManifests.delete(siteKey);
}

Deno.test({
  name: "statusRequest serves status without PUBLIC_DOMAIN",
  permissions: { env: true, read: true },
  async fn() {
    await withStatusEnv(async () => {
      const { statusRequest } = await loadStatusModule();
      const response = await statusRequest(
        new Request("http://gateway.example/status"),
      );
      assert(response instanceof Response);
      assertEquals(response.status, 200);
    });
  },
});

Deno.test({
  name: "statusRequest includes request port and requested columns",
  permissions: { env: true, read: true },
  async fn() {
    const rootEvent = createManifestEvent({
      id: "1".repeat(64),
      pubkey: "a".repeat(64),
      title: "Root site",
      paths: [
        ["index.html", "c".repeat(64)],
        ["about.html", "d".repeat(64)],
      ],
    });
    const namedEvent = createManifestEvent({
      id: "2".repeat(64),
      pubkey: "b".repeat(64),
      identifier: "blog",
      title: "Blog",
    });

    try {
      await cacheManifestEvent(rootEvent);
      await cacheManifestEvent(namedEvent);

      await withStatusEnv(async () => {
        const { statusRequest } = await loadStatusModule();
        const response = await statusRequest(
          new Request("http://gateway.example:3000/status"),
        );

        assert(response instanceof Response);
        assertEquals(response.status, 200);
        assertStringIncludes(
          response.headers.get("content-type") || "",
          "text/html",
        );

        const body = await response.text();
        assertStringIncludes(body, "Known cached sites");
        assertStringIncludes(body, "Root site");
        assertStringIncludes(body, "Blog");
        assertStringIncludes(body, "ROOT");
        assertStringIncludes(body, "2 cached sites");
        assertStringIncludes(body, "1 path");
        assertStringIncludes(body, "2 paths");
        assertStringIncludes(body, "gateway.example:3000");
        assertStringIncludes(body, ".gateway.example:3000/");
        assertStringIncludes(body, 'href="http://');
        assertStringIncludes(body, "npub");
      });
    } finally {
      await clearManifestCache(rootEvent);
      await clearManifestCache(namedEvent);
    }
  },
});

Deno.test({
  name: "server serves /status as a local route",
  permissions: { env: true, read: true },
  async fn() {
    const event = createManifestEvent({
      id: "3".repeat(64),
      pubkey: "c".repeat(64),
      title: "Gateway Site",
    });

    try {
      await cacheManifestEvent(event);

      await withServerEnv(async () => {
        const { default: app } = await loadServer();
        const response = await app.request("http://gateway.example/status");

        assertEquals(response.status, 200);
        assertStringIncludes(await response.text(), "Gateway Site");
      });
    } finally {
      await clearManifestCache(event);
    }
  },
});

Deno.test({
  name: "statusRequest renders on localhost hosts too",
  permissions: { env: true, read: true },
  async fn() {
    await withStatusEnv(async () => {
      const { statusRequest } = await loadStatusModule();
      const response = await statusRequest(
        new Request("http://localhost/status"),
      );

      assertEquals(response.status, 200);
    });
  },
});
