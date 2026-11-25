import { isBotUserAgent } from "./bots.ts";
import { LruCache } from "./lru.ts";

/** Header the loading page sets when polling for warm-up progress */
export const LOADING_POLL_HEADER = "nsite-warmup-poll";

/** Step a background warm-up is currently working on */
export type WarmupStage = "manifest" | "servers" | "blob";

/** Final result of a background warm-up */
export type WarmupOutcome = "ready" | "no-manifest" | "unavailable";

export interface WarmupJob {
  stage: WarmupStage;
  outcome?: WarmupOutcome;
  finishedAt?: number;
  done: Promise<WarmupOutcome>;
  /** Resolves on the next stage change (replaced after each change) */
  changed: Promise<void>;
}

/**
 * True when a request is a human browser navigation to a document, the only
 * kind of request that may receive the temporary loading page. Crawlers,
 * scripts, subresources, range requests and loading-page polls always get the
 * real (blocking) response.
 */
export function wantsLoadingPage(request: Request): boolean {
  if (request.method !== "GET") return false;
  const headers = request.headers;
  if (headers.has("range") || headers.has(LOADING_POLL_HEADER)) return false;
  if (isBotUserAgent(headers.get("user-agent"))) return false;

  const dest = headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe";
  return headers.get("accept")?.includes("text/html") ?? false;
}

/**
 * Resolves with the value, or undefined once `ms` elapses or `signal` aborts
 * first. Never rejects because of the timeout or the signal.
 */
export function withinGrace<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms);
    onAbort = () => resolve(undefined);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

/**
 * Deduplicates background warm-ups by key and remembers failed outcomes for
 * `failureTtl` ms so a reload after a failure renders the real error page
 * instead of looping on the loading page. At most `maxRunning` jobs run at
 * once, so requests that hang up immediately cannot queue unbounded
 * background work.
 */
export class WarmupRegistry {
  #jobs: LruCache<string, WarmupJob>;
  #failureTtl: number;
  #maxRunning: number;
  #running = 0;
  #now: () => number;

  constructor(options: {
    maxSize: number;
    maxRunning: number;
    failureTtl: number;
    now?: () => number;
  }) {
    this.#jobs = new LruCache(options.maxSize);
    this.#maxRunning = options.maxRunning;
    this.#failureTtl = options.failureTtl;
    this.#now = options.now ?? Date.now;
  }

  /** Number of jobs currently running */
  get running(): number {
    return this.#running;
  }

  /** Returns a running job, or a finished one that is still remembered */
  get(key: string): WarmupJob | undefined {
    const job = this.#jobs.get(key);
    if (job?.finishedAt === undefined) return job;
    if (this.#now() - job.finishedAt > this.#failureTtl) return undefined;
    return job;
  }

  /** Returns the recent failure for a key, if any */
  getFailure(key: string): WarmupOutcome | undefined {
    const outcome = this.get(key)?.outcome;
    return outcome && outcome !== "ready" ? outcome : undefined;
  }

  /**
   * Joins a running job for `key` or starts a new one. A thrown error counts
   * as "unavailable". Returns undefined when a new job is needed but
   * `maxRunning` jobs are already running.
   */
  start(
    key: string,
    run: (setStage: (stage: WarmupStage) => void) => Promise<WarmupOutcome>,
  ): WarmupJob | undefined {
    const existing = this.get(key);
    if (
      existing &&
      (existing.finishedAt === undefined || existing.outcome !== "ready")
    ) {
      return existing;
    }

    if (this.#running >= this.#maxRunning) return undefined;
    this.#running++;

    let notify!: () => void;
    const job = { stage: "manifest" } as WarmupJob;
    job.changed = new Promise((resolve) => notify = resolve);
    const setStage = (stage: WarmupStage) => {
      if (stage === job.stage) return;
      job.stage = stage;
      const previous = notify;
      job.changed = new Promise((resolve) => notify = resolve);
      previous();
    };
    job.done = Promise.resolve()
      .then(() => run(setStage))
      .catch((): WarmupOutcome => "unavailable")
      .then((outcome) => {
        this.#running--;
        job.outcome = outcome;
        job.finishedAt = this.#now();
        return outcome;
      });
    this.#jobs.set(key, job);
    return job;
  }
}
