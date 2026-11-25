import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import {
  CacheAdmissionError,
  VerifiedBlobCache,
  type VerifiedCacheOptions,
} from "../verified-blob-cache.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const sources = () => Promise.resolve(["https://fixture.example/blob"]);
const request = { publisher: "alice", sources };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => resolve = yes);
  return { promise, resolve };
}
async function fixture(
  run: (
    cache: VerifiedBlobCache,
    directory: string,
    options: VerifiedCacheOptions,
  ) => Promise<void>,
  overrides: Partial<VerifiedCacheOptions> = {},
) {
  const directory = await Deno.makeTempDir();
  const options = {
    directory,
    quota: 1024,
    maxFileSize: 256,
    fills: 2,
    pending: 16,
    waiters: 32,
    sources: 3,
    entries: 8,
    readers: 8,
    fillTimeout: 2000,
    stallTimeout: 500,
    ...overrides,
  };
  const originalFetch = globalThis.fetch;
  const cache = new VerifiedBlobCache(options);
  try {
    await run(cache, directory, options);
  } finally {
    globalThis.fetch = originalFetch;
    await cache.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("verified cache: corruption is never returned; retries and cold HTTP semantics", () =>
  fixture(async (cache) => {
    let calls = 0;
    const bad: string[] = [];
    globalThis.fetch = (_input, init) => {
      assertEquals(init?.method, "GET");
      assertEquals(
        new Headers(init?.headers).get("accept-encoding"),
        "identity",
      );
      assertEquals(new Headers(init?.headers).has("range"), false);
      calls++;
      return Promise.resolve(
        new Response(calls === 1 ? "corrupt" : "verified"),
      );
    };
    const response = await cache.response(hash("verified"), {
      ...request,
      sources: () =>
        Promise.resolve(["https://bad.example/", "https://good.example/"]),
      bad: (url) => {
        bad.push(url);
        return Promise.resolve();
      },
      headers: { range: "bytes=1-3" },
    });
    assertEquals(response?.status, 206);
    assertEquals(await response?.text(), "eri");
    assertEquals(response?.headers.get("content-range"), "bytes 1-3/8");
    assertEquals(bad, ["https://bad.example/"]);
    const head = await cache.response(hash("verified"), {
      ...request,
      method: "HEAD",
    });
    assertEquals(head?.headers.get("content-length"), "8");
    assertEquals(await head?.text(), "");
    const conditional = await cache.response(hash("verified"), {
      ...request,
      headers: { "if-none-match": `W/"${hash("verified")}"` },
    });
    assertEquals(conditional?.status, 304);
    const suffix = await cache.response(hash("verified"), {
      ...request,
      headers: { range: "bytes=-2" },
    });
    assertEquals(await suffix?.text(), "ed");
    const invalid = await cache.response(hash("verified"), {
      ...request,
      headers: { range: "bytes=8-" },
    });
    assertEquals(invalid?.status, 416);
    const stale = await cache.response(hash("verified"), {
      ...request,
      headers: { range: "bytes=1-2", "if-range": '"old"' },
    });
    assertEquals(stale?.status, 200);
    assertEquals(await stale?.text(), "verified");
    assertEquals(calls, 2);
    assertEquals(cache.metrics.corrupt, 1);

    // Neither HEAD nor a matching conditional may bypass a cold fill.
    globalThis.fetch = () => Promise.resolve(new Response("corrupt"));
    assertEquals(
      await cache.response(hash("missing"), { ...request, method: "HEAD" }),
      undefined,
    );
    assertEquals(
      await cache.response(hash("missing"), {
        ...request,
        headers: { "if-none-match": `"${hash("missing")}"` },
      }),
      undefined,
    );
  }));

Deno.test("verified cache: incremental fill is invisible until EOF; dedupe; publisher recovery", () =>
  fixture(async (cache) => {
    const started = deferred<void>();
    const finish = deferred<void>();
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encode("ver"));
              started.resolve();
              await finish.promise;
              controller.enqueue(encode("ified"));
              controller.close();
            },
          }),
        ),
      );
    };
    let served = false;
    const first = cache.response(hash("verified"), request).then((r) => {
      served = true;
      return r;
    });
    await started.promise;
    const second = cache.response(hash("verified"), {
      ...request,
      publisher: "bob",
    });
    assertEquals(served, false);
    assertEquals(cache.metrics.reserved, 256);
    assertEquals(cache.metrics.bytes, 0);
    finish.resolve();
    assertEquals(await (await first)?.text(), "verified");
    assertEquals(await (await second)?.text(), "verified");
    assertEquals(calls, 1);

    const began = deferred<void>();
    const release = deferred<void>();
    globalThis.fetch = async (input) => {
      if (String(input).includes("alice")) {
        began.resolve();
        await release.promise;
        return new Response("bad");
      }
      return new Response("recovery");
    };
    const a = cache.response(hash("recovery"), {
      ...request,
      sources: () => Promise.resolve(["https://alice.example/"]),
    });
    await began.promise;
    const b = cache.response(hash("recovery"), {
      ...request,
      publisher: "bob",
      sources: () => Promise.resolve(["https://bob.example/"]),
    });
    release.resolve();
    assertEquals(await a, undefined);
    assertEquals(await (await b)?.text(), "recovery");
    assertEquals(cache.metrics.reserved, 0);
  }));

Deno.test("verified cache: bounded queue, waiters, cancellation, reservations", () =>
  fixture(async (cache) => {
    const began = deferred<void>();
    globalThis.fetch = (_input, init) => {
      began.resolve();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    };
    const abort = new AbortController();
    const first = cache.response(hash("first"), {
      ...request,
      signal: abort.signal,
    });
    await began.promise;
    const queuedAbort = new AbortController();
    const queued = cache.response(hash("queued"), {
      ...request,
      signal: queuedAbort.signal,
    });
    await assertRejects(
      () => cache.response(hash("overflow"), request),
      CacheAdmissionError,
    );
    assertEquals(cache.metrics.active, 1);
    assertEquals(cache.metrics.pending, 1);
    queuedAbort.abort();
    await assertRejects(() => queued);
    assertEquals(cache.metrics.pending, 0);
    abort.abort();
    await assertRejects(() => first);
    await cache.close();
    assertEquals(cache.metrics.reserved, 0);
  }, { fills: 1, pending: 1, waiters: 2 }));

Deno.test("verified cache: LRU eviction, active pins, metadata and reader limits", () =>
  fixture(async (cache) => {
    const large = "a".repeat(200_000);
    globalThis.fetch = () => Promise.resolve(new Response(large));
    const pinned = await cache.response(hash(large), request);
    // Auto-pull reads at most 64 KiB; this file remains pinned until consumed.
    assertEquals(cache.metrics.readers, 1);
    await assertRejects(
      () => cache.response(hash(large), request),
      CacheAdmissionError,
    );
    await assertRejects(
      () => cache.response(hash("b"), request),
      CacheAdmissionError,
    );
    await pinned?.body?.cancel();
    globalThis.fetch = () => Promise.resolve(new Response("b"));
    assertEquals(await (await cache.response(hash("b"), request))?.text(), "b");
    assertEquals(cache.metrics.evictions, 1);
    assertEquals(cache.metrics.bytes, 1);
    assertEquals(cache.metrics.readers, 0);
  }, { quota: 200_000, maxFileSize: 200_000, entries: 1, readers: 1 }));

Deno.test("verified cache: size, encoding, truncation, stall and whole-fill limits clean temporary files", () =>
  fixture(async (cache, directory) => {
    for (
      const response of [
        new Response("a".repeat(257)),
        new Response("verified", { headers: { "content-encoding": "gzip" } }),
        new Response("verified", { headers: { "content-length": "9" } }),
        new Response("verified", { status: 206 }),
      ]
    ) {
      globalThis.fetch = () => Promise.resolve(response);
      assertEquals(await cache.response(hash("verified"), request), undefined);
      assertEquals(cache.metrics.bytes, 0);
      assertEquals(cache.metrics.reserved, 0);
      assertEquals(
        [...Deno.readDirSync(directory)].map((entry) => entry.name),
        [".lock"],
      );
    }
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason), { once: true });
      });
    assertEquals(await cache.response(hash("verified"), request), undefined);
    assertEquals(cache.metrics.reserved, 0);
  }, { stallTimeout: 10 }));

Deno.test("verified cache: trusted restart, abandoned temp cleanup, exclusive lock and safe paths", () =>
  fixture(async (cache, directory, options) => {
    globalThis.fetch = () => Promise.resolve(new Response("verified"));
    assertEquals(
      await (await cache.response(hash("verified"), request))?.text(),
      "verified",
    );
    assertThrows(() => new VerifiedBlobCache(options), Error, "already in use");
    await assertRejects(
      () => cache.response("../escape", request),
      Error,
      "Invalid blob hash",
    );
    await cache.close();
    await Deno.writeTextFile(`${directory}/dead.tmp`, "abandoned");
    const restarted = new VerifiedBlobCache(options);
    try {
      globalThis.fetch = () => {
        throw new Error("Must use persisted verified bytes");
      };
      assertEquals(
        await (await restarted.response(hash("verified"), request))?.text(),
        "verified",
      );
      assertEquals(
        [...Deno.readDirSync(directory)].some((entry) =>
          entry.name.endsWith(".tmp")
        ),
        false,
      );
    } finally {
      await restarted.close();
    }
  }));

Deno.test("verified cache: queue limit independent of waiter limit; shared cancellation", () =>
  fixture(async (cache) => {
    const began = deferred<void>();
    const finish = deferred<void>();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      began.resolve();
      await finish.promise;
      return new Response("shared");
    };
    const abort = new AbortController();
    const a = cache.response(hash("shared"), {
      ...request,
      signal: abort.signal,
    });
    await began.promise;
    const b = cache.response(hash("shared"), { ...request, publisher: "bob" });
    const queuedAbort = new AbortController();
    const queued = cache.response(hash("queued"), {
      ...request,
      signal: queuedAbort.signal,
    });
    await assertRejects(
      () => cache.response(hash("overflow"), request),
      CacheAdmissionError,
      "queue",
    );
    abort.abort();
    await assertRejects(() => a);
    queuedAbort.abort();
    await assertRejects(() => queued);
    finish.resolve();
    assertEquals(await (await b)?.text(), "shared");
    assertEquals(calls, 1);
  }, { fills: 1, pending: 1, waiters: 8 }));

Deno.test("verified cache: cleanup failure retains reservation and fails closed", () =>
  fixture(async (cache) => {
    const originalRemove = Deno.remove;
    globalThis.fetch = () => Promise.resolve(new Response("corrupt"));
    Deno.remove = (path, options) =>
      String(path).endsWith(".tmp")
        ? Promise.reject(new Error("simulated unlink failure"))
        : originalRemove(path, options);
    try {
      await assertRejects(
        () => cache.response(hash("verified"), request),
        Error,
        "unlink failure",
      );
      assertEquals(cache.metrics.reserved, 256);
      await assertRejects(
        () => cache.response(hash("another"), request),
        CacheAdmissionError,
      );
    } finally {
      Deno.remove = originalRemove;
    }
  }));

Deno.test("verified cache: whole-fill deadline bounds repeated progress", () =>
  fixture(async (cache) => {
    globalThis.fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const timer = setInterval(
                () => controller.enqueue(encode("a")),
                5,
              );
              init?.signal?.addEventListener("abort", () => {
                clearInterval(timer);
                controller.error(init.signal?.reason);
              }, { once: true });
            },
          }),
        ),
      );
    assertEquals(await cache.response(hash("verified"), request), undefined);
    assertEquals(cache.metrics.reserved, 0);
  }, { fillTimeout: 30, stallTimeout: 100 }));

Deno.test("verified cache: unsafe directory and symlink entries are refused", async () => {
  const directory = await Deno.makeTempDir();
  const options = {
    directory,
    quota: 1024,
    maxFileSize: 256,
    fills: 2,
    pending: 16,
    waiters: 32,
    sources: 3,
    entries: 8,
    readers: 8,
    fillTimeout: 2000,
    stallTimeout: 500,
  };
  try {
    await Deno.chmod(directory, 0o755);
    assertThrows(() => new VerifiedBlobCache(options), Error, "private");
    await Deno.chmod(directory, 0o700);
    await Deno.symlink("/etc/passwd", `${directory}/${hash("verified")}.blob`);
    assertThrows(() => new VerifiedBlobCache(options), Error, "Unsafe");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("verified cache: concurrent reservations include every temporary fill", () =>
  fixture(async (cache) => {
    const began = deferred<void>();
    const finish = deferred<void>();
    let started = 0;
    globalThis.fetch = async () => {
      if (++started === 2) began.resolve();
      await finish.promise;
      return new Response("verified");
    };
    const a = cache.response(hash("verified"), request);
    const b = cache.response(hash("different"), request);
    await began.promise;
    assertEquals(cache.metrics.reserved, 512);
    assertEquals(cache.metrics.active, 2);
    const c = cache.response(hash("queued"), request);
    assertEquals(cache.metrics.pending, 1);
    finish.resolve();
    assertEquals(await (await a)?.text(), "verified");
    assertEquals(await b, undefined);
    assertEquals(await c, undefined);
    assertEquals(cache.metrics.reserved, 0);
  }, { quota: 512 }));

Deno.test("verified cache: idle readers release pins and file descriptors", () =>
  fixture(async (cache) => {
    const large = "x".repeat(200_000);
    globalThis.fetch = () => Promise.resolve(new Response(large));
    const response = await cache.response(hash(large), request);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEquals(cache.metrics.readers, 0);
    await assertRejects(() => response!.text(), Error, "stalled");
  }, { quota: 200_000, maxFileSize: 200_000, stallTimeout: 10 }));
