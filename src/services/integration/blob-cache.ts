// Explicit integration suite: uses an isolated in-memory KV and mocked HTTP.
// Run with `deno task test:blob-cache`.
import { assertEquals } from "jsr:@std/assert";
import { Hono } from "@hono/hono";
import { PrivateKeySigner } from "applesauce-signers";
import { createHash } from "node:crypto";

// Configure before importing the services; never open the operator's cache.
Deno.env.set("CACHE_PATH", ":memory:");
Deno.env.set("CACHE_RELAYS", "wss://cache.example");
Deno.env.set("BLOSSOM_PROXY", "https://proxy.example/");
const directory = await Deno.makeTempDir();
Deno.env.set("BLOB_CACHE_DIR", directory);
Deno.env.set("BLOB_CACHE_FILLS", "1");
Deno.env.set("BLOB_CACHE_PENDING", "1");
Deno.env.set("BLOB_CACHE_WAITERS", "2");
const { cache, ...cached } = await import("../cache.ts");
const {
  findBlobURLs,
  streamBlob,
  markBadBlobSource,
  isBadBlobSource,
  verifiedBlobCache,
} = await import("../blossom.ts");

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const hash = createHash("sha256").update("fixture").digest("hex");
const aliceURL = `https://alice.example/${hash}`;
const bobURL = `https://bob.example/${hash}`;
const proxy = "https://proxy.example/";

async function resetCache() {
  for await (const entry of cache.list({ prefix: [] })) {
    await cache.delete(entry.key);
  }
}

Deno.test("blob source caches isolate publishers", async (t) => {
  try {
    await t.step("legacy global entries are ignored", async () => {
      await cache.set(["blob-server", hash], aliceURL);
      await cache.set(["blob-servers", hash], [aliceURL]);
      await cache.set(["blob-source-bad", hash, bobURL], { reason: "legacy" });
      assertEquals(await cached.getBlobServer(bob, hash), null);
      assertEquals(await cached.getBlobServers(bob, hash), null);
      assertEquals(await isBadBlobSource(bob, hash, bobURL), false);
      assertEquals(
        await findBlobURLs(hash, ["https://bob.example"], { pubkey: bob }),
        [bobURL],
      );
    });

    await t.step(
      "proxy hints are isolated and same-publisher discovery is reused",
      async () => {
        await resetCache();
        const a = await findBlobURLs(hash, ["https://alice.example"], {
          pubkey: alice,
          blossomProxy: proxy,
        });
        const b = await findBlobURLs(hash, ["https://bob.example"], {
          pubkey: bob,
          blossomProxy: proxy,
        });
        assertEquals(new URL(a[0]).searchParams.get("as"), alice);
        assertEquals(new URL(a[0]).searchParams.getAll("xs"), [
          "alice.example",
        ]);
        assertEquals(new URL(b[0]).searchParams.get("as"), bob);
        assertEquals(new URL(b[0]).searchParams.getAll("xs"), ["bob.example"]);
        assertEquals(a[1], aliceURL);
        assertEquals(b[1], bobURL);
        assertEquals(
          await findBlobURLs(hash, ["https://changed.example"], {
            pubkey: alice,
          }),
          a,
        );
      },
    );

    await t.step(
      "streaming ignores another publisher's preferred source and reuses its own",
      async () => {
        await resetCache();
        await cached.setBlobServer(alice, hash, aliceURL);
        const requests: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input) => {
          requests.push(String(input));
          return Promise.resolve(new Response("fixture", { status: 200 }));
        };
        try {
          await streamBlob(hash, ["https://bob.example"], {
            pubkey: bob,
            method: "HEAD",
          });
          assertEquals(requests, [bobURL]);
          // Wait for prior KV operations before checking the asynchronous write.
          assertEquals(await cached.getBlobServer(bob, hash), bobURL);
          await cached.clearBlobServers(bob, hash);
          await streamBlob(hash, ["https://changed.example"], {
            pubkey: bob,
            method: "HEAD",
          });
          // Verified bytes are now reusable globally without any upstream call.
          assertEquals(requests, [bobURL]);
          assertEquals(await cached.getBlobServer(alice, hash), aliceURL);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );

    await t.step(
      "failed fetches clear only the requesting publisher's preferred source",
      async () => {
        await resetCache();
        const hash = "c".repeat(64);
        await cached.setBlobServer(alice, hash, aliceURL);
        await cached.setBlobServer(bob, hash, bobURL);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = () =>
          Promise.resolve(new Response(null, { status: 503 }));
        try {
          assertEquals(
            await streamBlob(hash, ["https://bob.example"], {
              pubkey: bob,
              method: "HEAD",
            }),
            undefined,
          );
          assertEquals(await cached.getBlobServer(bob, hash), null);
          assertEquals(await cached.getBlobServer(alice, hash), aliceURL);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );

    await t.step(
      "bad-source invalidation and recovery stay publisher scoped",
      async () => {
        await resetCache();
        // Even when both publishers use the very same URL, invalidation is scoped.
        for (const pubkey of [alice, bob]) {
          await cached.setBlobServer(pubkey, hash, aliceURL);
          await cached.setBlobServers(pubkey, hash, [aliceURL]);
        }
        await markBadBlobSource(alice, hash, aliceURL);
        assertEquals(await cached.getBlobServer(alice, hash), null);
        assertEquals(await cached.getBlobServers(alice, hash), null);
        assertEquals(await isBadBlobSource(alice, hash, aliceURL), true);
        assertEquals(await cached.getBlobServer(bob, hash), aliceURL);
        assertEquals(await cached.getBlobServers(bob, hash), [aliceURL]);
        assertEquals(await isBadBlobSource(bob, hash, aliceURL), false);
        assertEquals(
          await findBlobURLs(hash, ["https://alice.example"], {
            pubkey: alice,
          }),
          [],
        );
        await cached.setBadBlobSource(bob, hash, aliceURL, "hash_mismatch");
        await cached.clearBadBlobSource(alice, hash, aliceURL);
        assertEquals(await isBadBlobSource(alice, hash, aliceURL), false);
        assertEquals(await isBadBlobSource(bob, hash, aliceURL), true);
      },
    );

    await t.step(
      "snapshot routes use the manifest publisher for sources and proxy hints",
      async () => {
        await resetCache();
        const { eventStore, getUserBlossomServers } = await import(
          "../nostr.ts"
        );
        const { handleSiteRequest } = await import("../../routes/site.tsx");
        const signer = new PrivateKeySigner();
        const hash = createHash("sha256").update("snapshot").digest("hex");
        const manifest = await signer.signEvent({
          kind: 5128,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [["path", "/file.txt", hash], ["path", "/404.html", hash], [
            "server",
            "https://snapshot.example",
          ]],
        });
        eventStore.add(manifest);
        // Prime the list's freshness without opening relay connections.
        await getUserBlossomServers(manifest.pubkey, 1);
        await cached.setBlobServer(alice, hash, aliceURL);
        const requests: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input) => {
          requests.push(String(input));
          return Promise.resolve(new Response("snapshot", { status: 200 }));
        };
        try {
          const app = new Hono();
          app.all(
            "*",
            (c) => handleSiteRequest(c, { type: "snapshot", id: manifest.id }),
          );
          const response = await app.request(
            "https://gateway.example/file.txt",
            { method: "HEAD" },
          );
          assertEquals(response.status, 200);
          assertEquals(requests.length, 1);
          const url = new URL(requests[0]);
          assertEquals(url.origin, "https://proxy.example");
          assertEquals(url.searchParams.get("as"), manifest.pubkey);
          assertEquals(url.searchParams.getAll("xs"), ["snapshot.example"]);
          assertEquals(
            await cached.getBlobServer(manifest.pubkey, hash),
            requests[0],
          );
          assertEquals(await cached.getBlobServer(alice, hash), aliceURL);
          const range = await app.request("https://gateway.example/file.txt", {
            headers: { range: "bytes=0-3" },
          });
          assertEquals(range.status, 206);
          assertEquals(await range.text(), "snap");
          const conditional = await app.request(
            "https://gateway.example/file.txt",
            {
              headers: { "if-none-match": `"${hash}"` },
            },
          );
          assertEquals(conditional.status, 304);
          const custom404 = await app.request(
            "https://gateway.example/missing",
            {
              headers: { range: "bytes=0-3", "if-none-match": `"${hash}"` },
            },
          );
          assertEquals(custom404.status, 404);
          assertEquals(await custom404.text(), "snapshot");
          assertEquals(requests.length, 1);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
    await t.step(
      "admission exhaustion returns explicit retryable 503",
      async () => {
        const originalFetch = globalThis.fetch;
        let started!: () => void;
        const began = new Promise<void>((resolve) => started = resolve);
        globalThis.fetch = (_input, init) => {
          started();
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        };
        const a = new AbortController();
        const b = new AbortController();
        const requests: Promise<unknown>[] = [];
        try {
          requests.push(
            streamBlob("d".repeat(64), ["https://fixture.example"], {
              pubkey: alice,
              signal: a.signal,
            }),
          );
          await began;
          requests.push(
            streamBlob("e".repeat(64), ["https://fixture.example"], {
              pubkey: alice,
              signal: b.signal,
            }),
          );
          const response = await streamBlob("f".repeat(64), [
            "https://fixture.example",
          ], {
            pubkey: alice,
          });
          assertEquals(response?.status, 503);
          assertEquals(response?.headers.get("retry-after"), "5");
          assertEquals(response?.headers.get("cache-control"), "no-store");
          await response?.body?.cancel();
        } finally {
          a.abort();
          b.abort();
          await Promise.allSettled(requests);
          globalThis.fetch = originalFetch;
        }
      },
    );
  } finally {
    await verifiedBlobCache.close();
    await Deno.remove(directory, { recursive: true });
    cache.close();
  }
});
