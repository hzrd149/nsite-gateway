import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { createHash } from "node:crypto";
import { newBlobObservation } from "../../helpers/request-log.ts";
import {
  CacheAdmissionError,
  VerifiedBlobCache,
  type VerifiedCacheOptions,
} from "../verified-blob-cache.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const sources = () => Promise.resolve(["https://fixture.example/blob"]);
const request = { publisher: "alice", sources };

Deno.test("verified cache: 217 cold dependencies, three visitors, fair competitors and warm reader burst", () =>
  fixture(async (cache, _directory, options) => {
    const gate = deferred<void>();
    const bodies = Array.from(
      { length: 219 },
      (_, i) => `${i}:` + "x".repeat(128 * 1024),
    );
    const hashes = bodies.map(hash);
    const starts: number[] = [];
    const calls = new Map<number, number>();
    globalThis.fetch = (input) => {
      const index = Number(new URL(String(input)).pathname.slice(1));
      calls.set(index, (calls.get(index) ?? 0) + 1);
      return Promise.resolve(new Response(bodies[index]));
    };
    const read = async (index: number, publisher = "alice") => {
      const response = await cache.response(hashes[index], {
        publisher,
        sources: async () => {
          starts.push(index);
          assertEquals(cache.metrics.active <= 2, true);
          assertEquals(cache.metrics.reserved <= 2 * options.maxFileSize, true);
          assertEquals(
            cache.metrics.bytes + cache.metrics.reserved <= options.quota,
            true,
          );
          await gate.promise;
          return [`https://fixture.example/${index}`];
        },
      });
      assertEquals(response?.status, 200);
      assertEquals(await response?.text(), bodies[index]);
    };
    const visitors = Array.from(
      { length: 3 },
      () => Array.from({ length: 217 }, (_, i) => read(i)),
    ).flat();
    const competitors = [read(217, "bob"), read(218, "carol")];
    assertEquals(cache.metrics.active, 2);
    assertEquals(cache.metrics.pending, 217);
    assertEquals(cache.metrics.waiters, 653);
    gate.resolve();
    await Promise.all([...visitors, ...competitors]);
    assertEquals(calls.size, 219);
    assertEquals([...calls.values()].every((count) => count === 1), true);
    assertEquals(starts.indexOf(217) <= 3, true);
    assertEquals(starts.indexOf(218) <= 4, true);
    assertEquals(cache.metrics.waiters, 0);
    assertEquals(cache.metrics.pending, 0);
    // Each stream is larger than the auto-pull buffer: admission must wait,
    // rather than opening 217 files or rejecting reads beyond the FD bound.
    const warm = hashes.slice(0, 217).map((hash) =>
      cache.response(hash, request)
    );
    assertEquals(cache.metrics.readers, 128);
    assertEquals(cache.metrics.readerWaiters, 89);
    await Promise.all(warm.map(async (response, i) => {
      assertEquals(await (await response)?.text(), bodies[i]);
      assertEquals(cache.metrics.readers <= 128, true);
    }));
    assertEquals(cache.metrics.readers, 0);
    assertEquals(cache.metrics.readerWaiters, 0);
    assertEquals(cache.metrics.reserved, 0);
  }, {
    quota: 64 * 1024 * 1024,
    maxFileSize: 256 * 1024,
    entries: 512,
    pending: 512,
    waiters: 1024,
    readers: 128,
    queueTimeout: 120_000,
    stallTimeout: 10_000,
  }));

Deno.test("verified cache: queue deadline and separate same-hash bounds clean admission", () =>
  fixture(async (cache) => {
    const abort = new AbortController();
    const blocked = {
      ...request,
      signal: abort.signal,
      sources: () => new Promise<string[]>(() => {}),
    };
    const first = cache.response(hash("first"), blocked);
    const follower = cache.response(hash("first"), blocked);
    await assertRejects(
      () => cache.response(hash("first"), request),
      CacheAdmissionError,
      "Per-fill",
    );
    const expired = cache.response(hash("expired"), request);
    await assertRejects(() => expired, CacheAdmissionError, "queue deadline");
    assertEquals(cache.metrics.pending, 0);
    assertEquals(cache.metrics.waiters, 2);
    const cancelled = new AbortController();
    const queued = cache.response(hash("cancelled"), {
      ...request,
      signal: cancelled.signal,
    });
    cancelled.abort();
    await assertRejects(() => queued);
    assertEquals(cache.metrics.pending, 0);
    abort.abort();
    await Promise.all([
      assertRejects(() => first),
      assertRejects(() => follower),
    ]);
    assertEquals(cache.metrics.waiters, 0);
  }, { fills: 1, perFillWaiters: 2, queueTimeout: 30 }));

Deno.test("verified cache: default 512-job and 1024-waiter overload bounds", () =>
  fixture(async (cache) => {
    const abort = new AbortController();
    const blocked = {
      ...request,
      signal: abort.signal,
      sources: () => new Promise<string[]>(() => {}),
    };
    const hashes = Array.from({ length: 515 }, (_, i) => hash(String(i)));
    const pending = hashes.slice(0, 514).map((hash) =>
      cache.response(hash, blocked).catch((error) => error)
    );
    assertEquals(cache.metrics.active, 2);
    assertEquals(cache.metrics.pending, 512);
    await assertRejects(
      () => cache.response(hashes[514], blocked),
      CacheAdmissionError,
      "queue full",
    );
    pending.push(
      ...hashes.slice(0, 510).map((hash) =>
        cache.response(hash, blocked).catch((error) => error)
      ),
    );
    assertEquals(cache.metrics.waiters, 1024);
    await assertRejects(
      () => cache.response(hashes[0], blocked),
      CacheAdmissionError,
      "Fill waiters full",
    );
    assertEquals(cache.metrics.reserved <= 512, true);
    abort.abort();
    await Promise.all(pending);
    assertEquals(cache.metrics.pending, 0);
    assertEquals(cache.metrics.waiters, 0);
  }, { pending: 512, waiters: 1024 }));

Deno.test("verified cache: bounded warm admission, abort, deadline and shutdown cleanup", () =>
  fixture(async (cache) => {
    const body = "x".repeat(200_000);
    globalThis.fetch = () => Promise.resolve(new Response(body));
    const first = await cache.response(hash(body), request);
    const abort = new AbortController();
    const second = cache.response(hash(body), {
      ...request,
      signal: abort.signal,
    });
    await assertRejects(
      () => cache.response(hash(body), request),
      CacheAdmissionError,
      "reader queue",
    );
    abort.abort();
    await assertRejects(() => second);
    await assertRejects(
      () => cache.response(hash(body), request),
      CacheAdmissionError,
      "Reader queue deadline",
    );
    assertEquals(cache.metrics.readerWaiters, 0);
    const last = cache.response(hash(body), request);
    const rejected = assertRejects(() => last, CacheAdmissionError);
    await cache.close();
    await rejected;
    await first?.body?.cancel().catch(() => {});
    assertEquals(cache.metrics.readerWaiters, 0);
    assertEquals(cache.metrics.readers, 0);
  }, {
    quota: 400_000,
    maxFileSize: 200_000,
    readers: 1,
    waiters: 1,
    queueTimeout: 30,
  }));

Deno.test("verified cache: per-request timing, coalescing, cold and warm HTTP attribution", () =>
  fixture(async (cache) => {
    const started = deferred<void>();
    const finish = deferred<void>();
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              started.resolve();
              void finish.promise.then(() => {
                controller.enqueue(encode("verified"));
                controller.close();
              });
            },
          }),
        ),
      );
    const owner = newBlobObservation();
    const waiter = newBlobObservation();
    const first = cache.response(hash("verified"), {
      ...request,
      observation: owner,
      method: "HEAD",
      sources: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return await sources();
      },
    });
    await started.promise;
    const second = cache.response(hash("verified"), {
      ...request,
      observation: waiter,
      headers: { "if-none-match": `"${hash("verified")}"` },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish.resolve();
    assertEquals((await first)?.status, 200);
    assertEquals((await second)?.status, 304);
    assertEquals(owner.cache, "miss");
    assertEquals(owner.verification, "incremental-sha256");
    assertEquals(owner.verified, true);
    assertEquals(owner.verification_ms > 0, true);
    assertEquals(owner.cache_wait_ms - owner.verification_ms >= 35, true);
    assertEquals(waiter.cache, "coalesced");
    assertEquals(waiter.verification, "shared-fill");
    assertEquals(waiter.verification_ms, 0);
    assertEquals(waiter.verified, true);
    for (
      const [method, headers, status] of [
        ["HEAD", {}, 200],
        ["GET", { "if-none-match": `"${hash("verified")}"` }, 304],
        ["GET", { range: "bytes=1-3" }, 206],
        ["GET", { range: "bytes=999-" }, 416],
      ] as const
    ) {
      const observation = newBlobObservation();
      const response = await cache.response(hash("verified"), {
        ...request,
        method,
        headers,
        observation,
      });
      assertEquals(response?.status, status);
      await response?.body?.cancel();
      assertEquals(observation, {
        cache: "hit",
        verification: "previously-verified",
        verification_ms: 0,
        cache_wait_ms: 0,
        verified: true,
      });
    }
    // A cold range still verifies the entire file.
    globalThis.fetch = () => Promise.resolve(new Response("range"));
    const range = newBlobObservation();
    const response = await cache.response(hash("range"), {
      ...request,
      observation: range,
      headers: { range: "bytes=1-2" },
    });
    assertEquals(await response?.text(), "an");
    assertEquals(range.cache, "miss");
    assertEquals(range.verification, "incremental-sha256");
    assertEquals(range.verified, true);
  }));

Deno.test("verified cache: failures and cancelled creators cannot borrow shared verification", () =>
  fixture(async (cache) => {
    const missing = newBlobObservation();
    assertEquals(
      await cache.response(hash("missing"), {
        ...request,
        sources: () => Promise.resolve([]),
        observation: missing,
      }),
      undefined,
    );
    assertEquals(missing.cache, "miss");
    assertEquals(missing.verification, "none");
    assertEquals(missing.verification_ms, 0);
    assertEquals(missing.verified, false);

    globalThis.fetch = () => Promise.resolve(new Response("corrupt"));
    const corrupt = newBlobObservation();
    assertEquals(
      await cache.response(hash("missing"), {
        ...request,
        observation: corrupt,
      }),
      undefined,
    );
    assertEquals(corrupt.verification, "incremental-sha256");
    assertEquals(corrupt.verified, false);

    const started = deferred<void>();
    const finish = deferred<void>();
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              started.resolve();
              void finish.promise.then(() => {
                controller.enqueue(encode("verified"));
                controller.close();
              });
            },
          }),
        ),
      );
    const controller = new AbortController();
    const owner = newBlobObservation();
    const first = cache.response(hash("verified"), {
      ...request,
      observation: owner,
      signal: controller.signal,
    });
    await started.promise;
    const waiter = newBlobObservation();
    const second = cache.response(hash("verified"), {
      ...request,
      observation: waiter,
    });
    // Let the owner enter the streaming loop before cancellation.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("fixture disconnect"));
    await assertRejects(() => first, Error, "fixture disconnect");
    const snapshot = { ...owner };
    assertEquals(owner.verification, "incremental-sha256");
    assertEquals(owner.verified, false);
    finish.resolve();
    assertEquals(await (await second)?.text(), "verified");
    assertEquals(owner, snapshot);
    assertEquals(waiter.verification, "shared-fill");
    assertEquals(waiter.verification_ms, 0);
    assertEquals(waiter.verified, true);
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Regression: operation did not finish")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    perFillWaiters: 32,
    queueTimeout: 2000,
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
  }, {
    quota: 200_000,
    maxFileSize: 200_000,
    entries: 1,
    readers: 1,
    queueTimeout: 30,
  }));

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
    perFillWaiters: 32,
    queueTimeout: 2000,
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

Deno.test("verified cache: immediate replacement waits for aborted same-hash cleanup", () =>
  fixture(async (cache) => {
    const reading = deferred<void>();
    const cleaning = deferred<void>();
    const releaseCleanup = deferred<void>();
    const originalRemove = Deno.remove;
    let calls = 0;
    globalThis.fetch = (_input, init) => {
      if (++calls > 1) return Promise.resolve(new Response("verified"));
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(init.signal?.reason),
                { once: true },
              );
            },
            pull() {
              reading.resolve();
            },
          }, { highWaterMark: 0 }),
        ),
      );
    };
    Deno.remove = async (path, options) => {
      if (String(path).endsWith(".tmp")) {
        cleaning.resolve();
        await releaseCleanup.promise;
      }
      return originalRemove(path, options);
    };
    const abort = new AbortController();
    const first = cache.response(hash("verified"), {
      ...request,
      signal: abort.signal,
    });
    let replacement: Promise<Response | undefined> | undefined;
    try {
      await within(reading.promise);
      abort.abort();
      await assertRejects(() => within(first));
      await within(cleaning.promise);
      replacement = cache.response(hash("verified"), request);
      void replacement.catch(() => {});
      // Even with two available fill slots, the hash must remain occupied.
      assertEquals(calls, 1);
      assertEquals(cache.metrics.active, 1);
      assertEquals(cache.metrics.reserved, 256);
      const cancelled = new AbortController();
      const follower = cache.response(hash("verified"), {
        ...request,
        signal: cancelled.signal,
      });
      await assertRejects(
        () => cache.response(hash("verified"), request),
        CacheAdmissionError,
        "Per-fill",
      );
      cancelled.abort();
      await assertRejects(() => within(follower));
      assertEquals(calls, 1);
      assertEquals(cache.metrics.active, 1);
      await assertRejects(
        () => replacement!,
        CacheAdmissionError,
        "Retiring fill queue deadline",
      );
      assertEquals(cache.metrics.waiters, 0);
      assertEquals(cache.metrics.active, 1);
      assertEquals(calls, 1);
      replacement = cache.response(hash("verified"), request);
      releaseCleanup.resolve();
      assertEquals(await (await within(replacement))?.text(), "verified");
      assertEquals(calls, 2);
      assertEquals(cache.metrics.reserved, 0);
    } finally {
      abort.abort();
      releaseCleanup.resolve();
      await first.catch(() => {});
      Deno.remove = originalRemove;
      await replacement?.then(
        (response) => response?.body?.cancel().catch(() => {}),
        () => {},
      );
    }
  }, { perFillWaiters: 2, queueTimeout: 30 }));

Deno.test("verified cache: discovery deadline releases admission and ignores late settlement", () =>
  fixture(async (cache) => {
    const discovery = deferred<string[]>();
    let signal!: AbortSignal;
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(new Response("verified"));
    };
    const pending = cache.response(hash("verified"), {
      ...request,
      sources: (received) => {
        signal = received;
        return discovery.promise;
      },
    });
    try {
      await assertRejects(() => within(pending), Error, "Fill deadline");
      assertEquals(signal.aborted, true);
      assertEquals(cache.metrics.reserved, 0);
      assertEquals(cache.metrics.active, 0);
      discovery.resolve(["https://late.example"]);
      assertEquals(
        await (await within(cache.response(hash("verified"), request)))?.text(),
        "verified",
      );
      assertEquals(calls, 1); // Late discovery never starts an abandoned fetch.
    } finally {
      discovery.resolve([]);
      await pending.catch(() => {});
    }
  }, { fillTimeout: 25 }));

Deno.test("verified cache: stalled good/bad hints are bounded and release promotion pins", () =>
  fixture(async (cache) => {
    const good = deferred<void>();
    const bad = deferred<void>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    globalThis.fetch = () =>
      Promise.resolve(new Response(++calls === 1 ? "corrupt" : "verified"));
    const pending = cache.response(hash("verified"), {
      ...request,
      sources: () =>
        Promise.resolve(["https://bad.example", "https://good.example"]),
      bad: (_source, signal) => {
        signals.push(signal);
        return bad.promise;
      },
      good: (_source, signal) => {
        signals.push(signal);
        return good.promise;
      },
    });
    try {
      assertEquals(await (await within(pending))?.text(), "verified");
      assertEquals(signals.map((signal) => signal.aborted), [true, true]);
      assertEquals(cache.metrics.reserved, 0);
      assertEquals(cache.metrics.active, 0);
      // A leaked promotion pin would prevent this one-entry cache from evicting.
      globalThis.fetch = () => Promise.resolve(new Response("replacement"));
      assertEquals(
        await (await within(cache.response(hash("replacement"), request)))
          ?.text(),
        "replacement",
      );
      assertEquals(cache.metrics.evictions, 1);
      good.reject(new Error("late good rejection"));
      bad.reject(new Error("late bad rejection"));
      await within(cache.close());
    } finally {
      good.resolve();
      bad.resolve();
      await pending.catch(() => {});
    }
  }, { entries: 1, stallTimeout: 10 }));

Deno.test("verified cache: shutdown cancels hung discovery and pre/post-promotion hints", async () => {
  for (const phase of ["sources", "good", "bad"] as const) {
    await fixture(async (cache, directory, options) => {
      const entered = deferred<void>();
      const hung = deferred<never>();
      let signal!: AbortSignal;
      const callback = (received: AbortSignal) => {
        signal = received;
        entered.resolve();
        return hung.promise;
      };
      globalThis.fetch = () =>
        Promise.resolve(new Response(phase === "bad" ? "corrupt" : "verified"));
      const pending = cache.response(hash("verified"), {
        ...request,
        sources: phase === "sources" ? callback : sources,
        good: phase === "good"
          ? (_source, received) => callback(received)
          : undefined,
        bad: phase === "bad"
          ? (_source, received) => callback(received)
          : undefined,
      });
      void pending.catch(() => {});
      try {
        await within(entered.promise);
        await within(cache.close()); // Must not wait for the callbacks' own settlement.
        await within(pending.catch(() => {}));
        assertEquals(signal.aborted, true);
        assertEquals(cache.metrics.active, 0);
        assertEquals(cache.metrics.waiters, 0);
        assertEquals(cache.metrics.reserved, 0);
        assertEquals(
          [...Deno.readDirSync(directory)].some((file) =>
            file.name.endsWith(".tmp")
          ),
          false,
        );
        hung.reject(new Error(`late ${phase} rejection`));
        // Shutdown must release its directory lock as well as its fill slots.
        const reopened = new VerifiedBlobCache(options);
        await reopened.close();
      } finally {
        hung.reject(new Error("test cleanup"));
        await pending.catch(() => {});
      }
    });
  }
});

Deno.test("verified cache: whole-fill deadline also bounds post-promotion persistence", () =>
  fixture(async (cache) => {
    const hint = deferred<void>();
    globalThis.fetch = () => Promise.resolve(new Response("verified"));
    let signal!: AbortSignal;
    const response = cache.response(hash("verified"), {
      ...request,
      good: (_source, received) => {
        signal = received;
        return hint.promise;
      },
    });
    try {
      assertEquals(await (await within(response))?.text(), "verified");
      assertEquals(signal.aborted, true);
      assertEquals(cache.metrics.active, 0);
      assertEquals(cache.metrics.reserved, 0);
      await within(cache.close());
    } finally {
      hint.resolve();
      await response.catch(() => {});
    }
  }, { fillTimeout: 100, stallTimeout: 2000 }));
