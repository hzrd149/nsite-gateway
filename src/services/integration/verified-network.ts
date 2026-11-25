// Real HTTP, loopback fixtures only. No public relays or production blobs.
import { assertEquals } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { VerifiedBlobCache } from "../verified-blob-cache.ts";

Deno.test("verified HTTP fixture: corrupt retry, cold HEAD/304/range, encoding and stalled body", async () => {
  const directory = await Deno.makeTempDir();
  const text = "fixture content";
  const hash = createHash("sha256").update(text).digest("hex");
  const observed: string[] = [];
  let slowController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      const path = new URL(req.url).pathname;
      observed.push(path);
      assertEquals(req.method, "GET");
      assertEquals(req.headers.get("accept-encoding"), "identity");
      assertEquals(req.headers.has("range"), false);
      if (path === "/bad") return new Response("corrupt");
      if (path === "/gzip") {
        return new Response(new Uint8Array(gzipSync(text)), {
          headers: { "content-encoding": "gzip" },
        });
      }
      if (path === "/slow") {
        return new Response(
          new ReadableStream({
            start(controller) {
              slowController = controller;
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              slowController = undefined;
            },
          }),
        );
      }
      return new Response(text);
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const options = {
    directory,
    quota: 1024,
    maxFileSize: 256,
    fills: 2,
    pending: 4,
    waiters: 8,
    sources: 3,
    entries: 8,
    readers: 8,
    fillTimeout: 1000,
    stallTimeout: 100,
  };
  let cache = new VerifiedBlobCache(options);
  try {
    // Deno's native fetch may decode content, but must retain enough response
    // encoding information for this explicitly non-identity response to fail.
    assertEquals(
      await cache.response(hash, {
        publisher: "alice",
        sources: () => Promise.resolve([`${base}/gzip`]),
      }),
      undefined,
    );
    const head = await cache.response(hash, {
      publisher: "alice",
      method: "HEAD",
      sources: () => Promise.resolve([`${base}/bad`, `${base}/good`]),
    });
    assertEquals(head?.status, 200);
    assertEquals(head?.headers.get("content-length"), String(text.length));
    assertEquals(await head?.text(), "");
    assertEquals(observed, ["/gzip", "/bad", "/good"]);
    await cache.close();
    await Deno.remove(`${directory}/${hash}.blob`);
    cache = new VerifiedBlobCache(options);
    const conditional = await cache.response(hash, {
      publisher: "bob",
      headers: { "if-none-match": `"${hash}"` },
      sources: () => Promise.resolve([`${base}/good`]),
    });
    assertEquals(conditional?.status, 304);
    assertEquals(observed.length, 4);
    const range = await cache.response(hash, {
      publisher: "bob",
      headers: { range: "bytes=0-6" },
      sources: () => Promise.resolve([]),
    });
    assertEquals(range?.status, 206);
    assertEquals(await range?.text(), "fixture");
    assertEquals(observed.length, 4);
    assertEquals(
      await cache.response("a".repeat(64), {
        publisher: "alice",
        sources: () => Promise.resolve([`${base}/slow`]),
      }),
      undefined,
    );
    assertEquals(cache.metrics.reserved, 0);
    assertEquals(
      [...Deno.readDirSync(directory)].some((file) =>
        file.name.endsWith(".tmp")
      ),
      false,
    );
  } finally {
    await cache.close();
    try {
      slowController?.close();
    } catch { /* client already cancelled */ }
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
