import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import {
  fetchBlossom,
  isBlobHash,
  parseBlossomURL,
} from "../helpers/blossom.ts";
import { hasMatchingIfNoneMatch } from "../helpers/http-cache.ts";
import { type BlobObservation, logValue } from "../helpers/request-log.ts";

export class CacheAdmissionError extends Error {}
export class BlobIntegrityError extends Error {}

/** Stop waiting, but observe late rejection and never run an already-aborted callback. */
async function cancellable<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error("Aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  const operation = Promise.resolve().then(() => {
    signal?.throwIfAborted();
    return run();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export interface VerifiedCacheOptions {
  directory: string;
  quota: number;
  maxFileSize: number;
  fills: number;
  pending: number;
  waiters: number;
  sources: number;
  entries: number;
  readers: number;
  fillTimeout: number;
  stallTimeout: number;
}

interface Entry {
  size: number;
  pins: number;
}
interface Job {
  verificationMs: number;
  verificationStarted?: number;
  verificationAttempted: boolean;
  hash: string;
  publisher: string;
  controller: AbortController;
  waiters: number;
  run: () => Promise<boolean>;
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
  reject: (error: unknown) => void;
  entry?: Entry;
  retiring: boolean;
  retired: Promise<void>;
  retire: () => void;
}
export interface BlobRequest {
  observation?: BlobObservation;
  publisher: string;
  method?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
  sources: (signal: AbortSignal) => Promise<string[]>;
  good?: (source: string, signal: AbortSignal) => Promise<void>;
  bad?: (source: string, signal: AbortSignal) => Promise<void>;
}

/**
 * One process owns a private, trusted directory. Only *.blob names are committed
 * verified content; *.tmp are never readable through this API. A full maximum-
 * file reservation is held until promotion or successful unlink, including retry
 * attempts. Filesystem accounting is serialized; failed cleanup closes admission.
 */
export class VerifiedBlobCache {
  readonly metrics = {
    hits: 0,
    misses: 0,
    fills: 0,
    failures: 0,
    corrupt: 0,
    evictions: 0,
    rejected: 0,
    bytes: 0,
    reserved: 0,
    active: 0,
    pending: 0,
    waiters: 0,
    readers: 0,
  };
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private lock: Deno.FsFile;
  private mutation = Promise.resolve();
  private closed = false;
  private broken = false;
  private directory: string;
  private readClosers = new Set<() => void>();

  constructor(readonly options: VerifiedCacheOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (
        name !== "directory" &&
        (!Number.isSafeInteger(value) || Number(value) < 1)
      ) {
        throw new Error(`Invalid disk cache option: ${name}`);
      }
    }
    if (options.maxFileSize > options.quota) {
      throw new Error("MAX_FILE_SIZE must fit within BLOB_CACHE_BYTES");
    }
    this.directory = resolve(options.directory);
    Deno.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = Deno.lstatSync(this.directory);
    if (
      !stat.isDirectory || stat.isSymlink ||
      stat.uid !== Deno.uid() || ((stat.mode ?? 0) & 0o077) !== 0
    ) {
      throw new Error("Blob cache must be an owned, private (0700) directory");
    }
    const lockPath = `${this.directory}/.lock`;
    try {
      const info = Deno.lstatSync(lockPath);
      if (!info.isFile || info.isSymlink || info.nlink !== 1) {
        throw new Error("Unsafe blob cache lock");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.lock = Deno.openSync(lockPath, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    try {
      if (!this.lock.tryLockSync(true)) {
        throw new Error("Blob cache directory is already in use");
      }
      // Streaming scan keeps metadata bounded even after limits are reduced.
      for (const file of Deno.readDirSync(this.directory)) {
        if (file.name === ".lock") continue;
        const path = `${this.directory}/${file.name}`;
        const info = Deno.lstatSync(path);
        if (
          !info.isFile || info.isSymlink || info.nlink !== 1 ||
          info.uid !== Deno.uid()
        ) {
          throw new Error(`Unsafe blob cache entry: ${file.name}`);
        }
        if (/^[0-9a-f-]+\.tmp$/.test(file.name)) {
          Deno.removeSync(path);
        } else if (/^[0-9a-f]{64}\.blob$/.test(file.name)) {
          if (
            info.size > options.maxFileSize ||
            this.entries.size >= options.entries ||
            this.metrics.bytes + info.size > options.quota
          ) {
            Deno.removeSync(path);
          } else {
            this.entries.set(file.name.slice(0, 64), {
              size: info.size,
              pins: 0,
            });
            this.metrics.bytes += info.size;
          }
        } else {
          throw new Error(`Unexpected blob cache entry: ${file.name}`);
        }
      }
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  private path(hash: string) {
    return `${this.directory}/${hash}.blob`;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private reject(message: string): never {
    this.metrics.rejected++;
    throw new CacheAdmissionError(message);
  }

  private async makeRoom(bytes: number, entry = false) {
    while (
      this.metrics.bytes + this.metrics.reserved + bytes > this.options.quota ||
      (entry && this.entries.size >= this.options.entries)
    ) {
      const victim = [...this.entries].find(([, value]) => value.pins === 0);
      if (!victim) this.reject("Disk cache is pinned or fully reserved");
      // Remove metadata first: no new reader can pin a file being unlinked.
      const [hash, value] = victim;
      this.entries.delete(hash);
      try {
        await Deno.remove(this.path(hash));
      } catch (error) {
        this.broken = true;
        throw error;
      }
      this.metrics.bytes -= value.size;
      this.metrics.evictions++;
    }
  }

  private startJobs() {
    while (
      !this.closed && this.metrics.active < this.options.fills &&
      this.queue.length
    ) {
      const job = this.queue.shift()!;
      this.metrics.pending = this.queue.length;
      this.metrics.active++;
      void job.run().then(job.resolve, job.reject).finally(() => {
        this.releaseJobPin(job);
        if (this.jobs.get(job.hash) === job) this.jobs.delete(job.hash);
        this.metrics.active--;
        job.retire();
        this.startJobs();
      });
    }
  }

  private newJob(hash: string, request: BlobRequest): Job {
    if (this.closed || this.broken) this.reject("Disk cache unavailable");
    if (
      this.metrics.active >= this.options.fills &&
      this.queue.length >= this.options.pending
    ) this.reject("Fill queue full");
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A disconnected last waiter must not leave an unhandled rejection.
    void promise.catch(() => {});
    let retire!: () => void;
    const retired = new Promise<void>((resolve) => retire = resolve);
    const job: Job = {
      verificationMs: 0,
      verificationAttempted: false,
      hash,
      publisher: request.publisher,
      controller: new AbortController(),
      waiters: 0,
      promise,
      resolve,
      reject,
      retiring: false,
      retired,
      retire,
      run: () => this.fill(hash, request, job),
    };
    job.controller.signal.addEventListener("abort", () => {
      job.retiring = true;
    }, { once: true });
    this.jobs.set(hash, job);
    this.queue.push(job);
    this.metrics.pending = this.queue.length;
    this.startJobs();
    return job;
  }

  private async wait(job: Job, signal?: AbortSignal) {
    job.waiters++;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason ?? new Error("Request aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const ok = await Promise.race([job.promise, cancelled]);
      if (ok && job.entry) {
        // Transfer a pin to this request before its continuation can yield.
        job.entry.pins++;
        return job.entry;
      }
      return undefined;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (--job.waiters === 0) {
        // Keep the hash occupied until all disk cleanup has actually finished.
        job.retiring = true;
        this.releaseJobPin(job);
        const index = this.queue.indexOf(job);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.metrics.pending = this.queue.length;
          this.jobs.delete(job.hash);
          job.resolve(false);
          job.retire();
        }
        job.controller.abort();
      }
    }
  }

  private releaseJobPin(job: Job) {
    if (job.waiters === 0 && job.entry) {
      job.entry.pins--;
      job.entry = undefined;
    }
  }

  private async hint(
    callback: BlobRequest["good"],
    source: string,
    fillSignal: AbortSignal,
  ) {
    if (!callback) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([fillSignal, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(new Error("Hint deadline")),
      this.options.stallTimeout,
    );
    try {
      await cancellable(() => callback(source, signal), signal);
    } catch {
      // Hints cannot hold verified bytes, temporary files or admission forever.
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async fill(hash: string, request: BlobRequest, job: Job) {
    const controller = job.controller;
    const timer = setTimeout(
      () => controller.abort(new Error("Fill deadline")),
      this.options.fillTimeout,
    );
    let reserved = false;
    this.metrics.fills++;
    try {
      await this.exclusive(async () => {
        if (this.broken || this.closed) this.reject("Disk cache unavailable");
        controller.signal.throwIfAborted();
        await this.makeRoom(this.options.maxFileSize);
        this.metrics.reserved += this.options.maxFileSize;
        reserved = true;
      });
      const sources = (await cancellable(() =>
        request.sources(controller.signal), controller.signal)).slice(
          0,
          this.options.sources,
        );
      for (const source of sources) {
        controller.signal.throwIfAborted();
        const attempt = new AbortController();
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        let stalled: ReturnType<typeof setTimeout> | undefined;
        const resetStall = () => {
          clearTimeout(stalled);
          stalled = setTimeout(
            () =>
              attempt.abort(new Error("Upstream stalled")),
            this.options.stallTimeout,
          );
        };
        const temporary = `${this.directory}/${crypto.randomUUID()}.tmp`;
        let file: Deno.FsFile | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let created = false;
        try {
          resetStall();
          const response = await fetchBlossom(source, {
            method: "GET",
            headers: { "Accept-Encoding": "identity" },
            signal,
          });
          reader = response.body?.getReader();
          const encoding = response.headers.get("content-encoding");
          const length = response.headers.get("content-length");
          if (
            response.status !== 200 || !reader ||
            (encoding && encoding.toLowerCase() !== "identity") ||
            (length !== null && (!/^\d+$/.test(length) ||
              !Number.isSafeInteger(Number(length)) ||
              Number(length) > this.options.maxFileSize))
          ) {
            throw new Error("Unusable upstream status, encoding, or size");
          }
          file = await Deno.open(temporary, {
            createNew: true,
            write: true,
            mode: 0o600,
          });
          created = true;
          job.verificationAttempted = true;
          job.verificationStarted = performance.now();
          const digest = createHash("sha256");
          let size = 0;
          while (true) {
            resetStall();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) {
              break;
            }
            size += value.byteLength;
            if (size > this.options.maxFileSize) {
              throw new Error("Blob exceeds MAX_FILE_SIZE");
            }
            digest.update(value);
            let offset = 0;
            while (offset < value.byteLength) {
              offset += await file.write(value.subarray(offset));
            }
          }
          clearTimeout(stalled);
          if (digest.digest("hex") !== hash) {
            throw new BlobIntegrityError("SHA256 mismatch");
          }
          if (length !== null && Number(length) !== size) {
            throw new Error("Truncated upstream body");
          }
          job.verificationMs += performance.now() - job.verificationStarted;
          job.verificationStarted = undefined;
          await file.sync();
          file.close();
          file = undefined;
          await this.exclusive(async () => {
            signal.throwIfAborted();
            await this.makeRoom(0, true);
            await Deno.rename(temporary, this.path(hash));
            created = false;
            const entry = { size, pins: 1 };
            this.entries.set(hash, entry);
            job.entry = entry; // Hold until every waiting request acquires a pin.
            this.metrics.bytes += size;
            this.metrics.reserved -= this.options.maxFileSize;
            reserved = false;
          });
          // Source preferences are hints only; their persistence cannot affect bytes.
          await this.hint(request.good, source, controller.signal);
          return true;
        } catch (error) {
          if (job.verificationStarted !== undefined) {
            job.verificationMs += performance.now() - job.verificationStarted;
            job.verificationStarted = undefined;
          }
          this.metrics.failures++;
          if (error instanceof BlobIntegrityError) {
            this.metrics.corrupt++;
            await this.hint(request.bad, source, controller.signal);
          }
          console.warn(
            `[nsite:disk-cache] fill ${hash.slice(0, 12)} from ${
              parseBlossomURL(source)?.origin ?? "invalid-url"
            } failed: ${logValue(error)}`,
          );
          if (error instanceof CacheAdmissionError) {
            throw error;
          }
        } finally {
          clearTimeout(stalled);
          attempt.abort();
          await reader?.cancel().catch(() => {});
          try {
            file?.close();
            if (created) {
              await Deno.remove(temporary);
            }
          } catch (error) {
            // Keep the reservation charged and stop new fills until restart.
            this.broken = true;
            reserved = false;
            throw error;
          }
        }
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (reserved) {
        await this.exclusive(() => {
          this.metrics.reserved -= this.options.maxFileSize;
          return Promise.resolve();
        });
      }
    }
  }

  async response(
    hash: string,
    request: BlobRequest,
  ): Promise<Response | undefined> {
    const observation = request.observation;
    if (!isBlobHash(hash)) throw new Error("Invalid blob hash");
    if (this.closed || this.broken) this.reject("Disk cache unavailable");
    request.signal?.throwIfAborted();
    let entry = this.entries.get(hash);
    if (observation) observation.cache = entry ? "hit" : "miss";
    if (!entry) {
      if (this.metrics.waiters >= this.options.waiters) {
        this.reject("Fill waiters full");
      }
      this.metrics.waiters++;
      this.metrics.misses++;
      const waitingSince = performance.now();
      let ownedFill = false;
      try {
        while (!entry) {
          request.signal?.throwIfAborted();
          // A retired fill may have promoted verified bytes before cancellation.
          entry = this.entries.get(hash);
          if (entry) {
            entry.pins++;
            break;
          }
          const existing = this.jobs.get(hash);
          const job = existing ?? this.newJob(hash, request);
          if (!existing) ownedFill = true;
          if (observation) {
            observation.cache = ownedFill ? "miss" : "coalesced";
            if (!ownedFill) observation.verification = "shared-fill";
            else if (observation.verification === "shared-fill") {
              observation.verification = "none";
            }
          }
          if (job.retiring) {
            await cancellable(() => job.retired, request.signal);
            continue;
          }
          try {
            entry = await this.wait(job, request.signal);
          } catch (error) {
            if (
              request.signal?.aborted || error instanceof CacheAdmissionError ||
              job.publisher === request.publisher
            ) throw error;
          } finally {
            // Only the creator attributes this job's hashing. Cancellation takes
            // a snapshot: other waiters may continue after the creator leaves.
            if (!existing && observation && job.verificationAttempted) {
              observation.verification = "incremental-sha256";
              observation.verification_ms += job.verificationMs +
                (job.verificationStarted === undefined
                  ? 0
                  : performance.now() - job.verificationStarted);
            }
          }
          if (!entry && job.publisher === request.publisher) return undefined;
          if (!entry) await cancellable(() => job.retired, request.signal);
          // A foreign publisher's failure never poisons this publisher's fill.
        }
      } finally {
        if (observation) {
          observation.cache_wait_ms = performance.now() - waitingSince;
        }
        this.metrics.waiters--;
      }
    } else {
      this.metrics.hits++;
      if (observation) observation.verification = "previously-verified";
      entry.pins++;
    }
    try {
      if (observation) observation.verified = true;
      return await this.serve(hash, entry, request);
    } finally {
      entry.pins--;
    }
  }

  private async serve(hash: string, entry: Entry, request: BlobRequest) {
    request.signal?.throwIfAborted();
    this.entries.delete(hash);
    this.entries.set(hash, entry); // bounded LRU
    const headers = new Headers({
      "ETag": `"${hash}"`,
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
    });
    const incoming = new Headers(request.headers);
    if (hasMatchingIfNoneMatch(incoming, `"${hash}"`)) {
      return new Response(null, { status: 304, headers });
    }
    let start = 0;
    let end = entry.size - 1;
    let status = 200;
    const range = incoming.get("range");
    const ifRange = incoming.get("if-range");
    if (
      request.method !== "HEAD" && range &&
      (!ifRange || ifRange === `"${hash}"`)
    ) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1]
          ? Number(match[1])
          : Math.max(0, entry.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start > end || start >= entry.size
        ) {
          headers.set("Content-Range", `bytes */${entry.size}`);
          return new Response(null, { status: 416, headers });
        }
        status = 206;
        headers.set("Content-Range", `bytes ${start}-${end}/${entry.size}`);
      }
      // Unsupported/multipart ranges are ignored, as permitted by HTTP.
    }
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (request.method === "HEAD") {
      return new Response(null, { status, headers });
    }
    if (this.metrics.readers >= this.options.readers) {
      this.reject("Local reader limit reached");
    }
    entry.pins++;
    this.metrics.readers++;
    let file: Deno.FsFile | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const close = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      file?.close();
      entry.pins--;
      this.metrics.readers--;
      this.readClosers.delete(abort);
    };
    const abort = () => {
      if (!finished) {
        streamController?.error(new Error("Local read cancelled or stalled"));
      }
      close();
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(abort, this.options.stallTimeout);
    };
    try {
      file = await Deno.open(this.path(hash), { read: true });
      await file.seek(start, Deno.SeekMode.Start);
      if (this.closed) {
        throw new CacheAdmissionError("Disk cache shutting down");
      }
      request.signal?.throwIfAborted();
      let remaining = Math.max(0, end - start + 1);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        async pull(controller) {
          try {
            const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
            const count = remaining ? await file!.read(chunk) : null;
            if (finished) return;
            if (count === null && remaining) {
              throw new Error("Truncated local cache file");
            }
            if (count) {
              remaining -= count;
              controller.enqueue(chunk.subarray(0, count));
            }
            if (!remaining) {
              close();
              controller.close();
            } else reset();
          } catch (error) {
            if (!finished) {
              close();
              controller.error(error);
            }
          }
        },
        cancel: close,
      });
      request.signal?.addEventListener("abort", abort, { once: true });
      this.readClosers.add(abort);
      reset();
      return new Response(body, { status, headers });
    } catch (error) {
      close();
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.jobs.delete(job.hash);
      job.retiring = true;
      job.resolve(false);
      job.retire();
    }
    this.metrics.pending = 0;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      job.retiring = true;
      job.controller.abort();
    }
    await Promise.all(jobs.map((job) => job.retired));
    await this.mutation;
    for (const close of this.readClosers) close();
    this.lock.close();
  }
}
