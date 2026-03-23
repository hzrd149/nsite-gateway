import { assert, assertEquals } from "jsr:@std/assert@^1.0.15";

async function withKvEnv<T>(
  kvPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = {
    CACHE_BACKEND: Deno.env.get("CACHE_BACKEND"),
    KV_PATH: Deno.env.get("KV_PATH"),
  };

  Deno.env.set("CACHE_BACKEND", "kv");
  Deno.env.set("KV_PATH", kvPath);

  try {
    return await fn();
  } finally {
    if (previous.CACHE_BACKEND === undefined) Deno.env.delete("CACHE_BACKEND");
    else Deno.env.set("CACHE_BACKEND", previous.CACHE_BACKEND);

    if (previous.KV_PATH === undefined) Deno.env.delete("KV_PATH");
    else Deno.env.set("KV_PATH", previous.KV_PATH);
  }
}

async function loadCacheModule() {
  return await import(`../services/cache.ts?test=${crypto.randomUUID()}`);
}

Deno.test({
  name: "kv cache creates one store per cache inside the KV_PATH directory",
  permissions: { env: true, read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir();
    const kvPath = `${root}/cache`;

    try {
      await withKvEnv(kvPath, async () => {
        const cache = await loadCacheModule();

        try {
          await cache.initCache();

          await cache.pubkeyServers.set("site-key", ["wss://servers.example"]);
          await cache.pubkeyRelays.set("site-key", ["wss://relays.example"]);

          assertEquals(
            await cache.pubkeyServers.get("site-key"),
            ["wss://servers.example"],
          );
          assertEquals(
            await cache.pubkeyRelays.get("site-key"),
            ["wss://relays.example"],
          );

          const storeNames: string[] = [];
          for await (const entry of Deno.readDir(kvPath)) {
            if (entry.isFile) storeNames.push(entry.name);
          }

          for (
            const expected of [
              "domains.kv",
              "servers.kv",
              "relays.kv",
              "paths.kv",
              "manifest-paths.kv",
              "manifests.kv",
              "blobs.kv",
            ]
          ) {
            assert(storeNames.includes(expected), `missing ${expected}`);
          }
        } finally {
          await cache.closeCache();
        }
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
