// Real HTTP, loopback fixtures only. No public relays or production blobs.
import { assertEquals } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { VerifiedBlobCache } from "../verified-blob-cache.ts";

async function within<T>(promise: Promise<T>, lifecycle: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Lifecycle deadline: ${lifecycle}`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("corrected Deno abort: successful delivery releases readers, disconnect cancels pinned stream", async () => {
  const directory = await Deno.makeTempDir();
  const smallHash = createHash("sha256").update("ok").digest("hex");
  await Deno.writeTextFile(`${directory}/${smallHash}.blob`, "ok");
  // Trusted on-disk fixture large enough to retain backpressure on loopback.
  const chunk = new Uint8Array(1024 * 1024);
  const digest = createHash("sha256");
  const temporary = `${directory}/fixture`;
  const file = await Deno.open(temporary, { create: true, write: true });
  try {
    for (let n = 0; n < 32; n++) {
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        offset += await file.write(chunk.subarray(offset));
      }
    }
  } finally {
    file.close();
  }
  const largeHash = digest.digest("hex");
  await Deno.rename(temporary, `${directory}/${largeHash}.blob`);
  const cache = new VerifiedBlobCache({
    directory,
    quota: 64 * 1024 * 1024,
    maxFileSize: 32 * 1024 * 1024,
    fills: 1,
    pending: 1,
    waiters: 4,
    perFillWaiters: 4,
    queueTimeout: 2000,
    sources: 1,
    entries: 4,
    readers: 4,
    fillTimeout: 2000,
    // Idle cleanup must not satisfy the five-second disconnect assertion.
    stallTimeout: 10000,
  });
  let resolveSuccess!: () => void;
  const success = new Promise<void>((resolve) => resolveSuccess = resolve);
  let resolveDisconnected!: () => void;
  const disconnected = new Promise<void>((resolve) =>
    resolveDisconnected = resolve
  );
  let smallSignal: AbortSignal | undefined;
  let resolvePending!: () => void;
  const pending = new Promise<void>((resolve) => resolvePending = resolve);
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => resolveAborted = resolve);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req, info) => {
      if (new URL(req.url).pathname === "/pending") {
        req.signal.addEventListener("abort", resolveAborted, { once: true });
        try {
          await cache.response("a".repeat(64), {
            publisher: "fixture",
            signal: req.signal,
            sources: () => {
              resolvePending();
              return new Promise(() => {});
            },
          });
        } catch { /* expected disconnect */ }
        return new Response(null, { status: 503 });
      }
      const small = new URL(req.url).pathname === "/small";
      if (small) smallSignal = req.signal;
      void info.completed.then(() => {
        if (small) resolveSuccess();
      }, () => {});
      const response = (await cache.response(small ? smallHash : largeHash, {
        publisher: "fixture",
        signal: req.signal,
        sources: () => Promise.resolve([]),
      }))!;
      if (small) return response;
      // A disconnect can cancel the response body, or abort the request while a
      // pull is pending. In the latter case the cache errors the reader and the
      // wrapper becomes errored, so its cancel() callback will not run.
      const reader = response.body!.getReader();
      void reader.closed.catch(() => {
        if (req.signal.aborted) resolveDisconnected();
      });
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          async cancel(reason) {
            await reader.cancel(reason);
            resolveDisconnected();
          },
        }),
        { headers: response.headers },
      );
    },
  );
  let socket: Deno.TcpConn | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${server.addr.port}/small`);
    assertEquals(await response.text(), "ok");
    await within(success, "successful response completes");
    assertEquals(smallSignal?.aborted, false);
    assertEquals(cache.metrics.readers, 0);
    socket = await Deno.connect({
      hostname: "127.0.0.1",
      port: server.addr.port,
    });
    await socket.write(new TextEncoder().encode(
      "GET /large HTTP/1.1\r\nHost: fixture\r\n\r\n",
    ));
    await within(socket.read(new Uint8Array(1024)), "large response starts");
    assertEquals(cache.metrics.readers, 1);
    socket.close();
    socket = undefined;
    await within(disconnected, "large response is cancelled or aborted");
    assertEquals(cache.metrics.readers, 0);
    socket = await Deno.connect({
      hostname: "127.0.0.1",
      port: server.addr.port,
    });
    await socket.write(new TextEncoder().encode(
      "GET /pending HTTP/1.1\r\nHost: fixture\r\n\r\n",
    ));
    await within(pending, "pending request starts");
    socket.close();
    socket = undefined;
    await within(aborted, "pending request is aborted");
  } finally {
    socket?.close();
    await cache.close();
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

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
    perFillWaiters: 8,
    queueTimeout: 2000,
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
