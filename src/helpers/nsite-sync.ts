import {
  createSyncLoader,
  type SyncLoaderOptions,
  type SyncLoaderStatus,
} from "applesauce-loaders/loaders";
import { lastValueFrom, Observable } from "rxjs";
import {
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "./site-manifest.ts";

export const SITE_MANIFEST_KINDS = [
  ROOT_SITE_MANIFEST_KIND,
  NAMED_SITE_MANIFEST_KIND,
  MANIFEST_SNAPSHOT_KIND,
];

export const NSITE_SYNC_FILTERS = {
  manifests: { kinds: SITE_MANIFEST_KINDS },
  deletes: {
    kinds: [5],
    "#k": SITE_MANIFEST_KINDS.map(String),
  },
};

export type NsiteSyncPhase = keyof typeof NSITE_SYNC_FILTERS;

export type NsiteSyncOptions = {
  signal?: AbortSignal;
  /** Fixed upper bound shared by both filters; defaults to the start of this run. */
  until?: number;
  /** Inclusive lower bound shared by manifests and deletions; omitted means all history. */
  since?: number;
  /** Per-relay progress timeout, not a deadline for the whole hydration. */
  timeout?: number;
  /** Maximum wall-clock duration of both phases combined (default 120 seconds). */
  totalTimeout?: number;
};

export type NsiteSyncResult = {
  /** Unique accepted events received this run, not necessarily new to the store. */
  manifests: number;
  deletes: number;
  elapsedMs: number;
  complete: boolean;
  statuses: Record<NsiteSyncPhase, SyncLoaderStatus>;
};

/** Owns one loader over the application's pool/store, with no timestamp high-water mark. */
export function createNsiteSync(options: SyncLoaderOptions) {
  const loader = createSyncLoader(options);

  return async (
    relays: string[],
    options: NsiteSyncOptions = {},
  ): Promise<NsiteSyncResult> => {
    const started = performance.now();
    const until = options.until ?? Math.floor(Date.now() / 1000);
    const since = options.since;
    if (
      !Number.isSafeInteger(until) || until < 0 ||
      (since !== undefined &&
        (!Number.isSafeInteger(since) || since < 0 || since > until))
    ) {
      throw new RangeError(
        "Sync requires integer Unix seconds with 0 <= since <= until",
      );
    }
    const totalTimeout = options.totalTimeout ?? 120_000;
    if (
      !Number.isInteger(totalTimeout) || totalTimeout <= 0 ||
      totalTimeout > 2_147_483_647
    ) {
      throw new RangeError(
        "Total sync timeout must be between 1 and 2147483647 milliseconds",
      );
    }
    options.signal?.throwIfAborted();
    const deadline = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([deadline.signal, options.signal])
      : deadline.signal;
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            `Relay sync exceeded its ${totalTimeout}ms total deadline; hydration is partial`,
            "TimeoutError",
          ),
        ),
      totalTimeout,
    );

    const load = (phase: NsiteSyncPhase) => {
      const run = loader({
        relays,
        filter: {
          ...NSITE_SYNC_FILTERS[phase],
          until,
          ...(since === undefined ? {} : { since }),
        },
        timeout: options.timeout ?? 15_000,
        // The public gateway has no signing identity for relay authentication.
        waitForAuth: false,
      });

      // Subscribing to status$ starts the shared run and inserts events into the store.
      // Abort must reject (rather than resolve with a misleading partial success).
      return lastValueFrom(
        new Observable<SyncLoaderStatus>((subscriber) => {
          const abort = () => subscriber.error(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          const sub = run.status$.subscribe({
            next: (status) => {
              subscriber.next(status);
            },
            error: (error) => subscriber.error(error),
            complete: () => subscriber.complete(),
          });
          if (signal.aborted) abort();
          return () => {
            signal.removeEventListener("abort", abort);
            sub.unsubscribe();
          };
        }),
      );
    };

    try {
      const [manifests, deletes] = await Promise.all([
        load("manifests"),
        load("deletes"),
      ]);
      const statuses = { manifests, deletes };
      return {
        manifests: manifests.loaded,
        deletes: deletes.loaded,
        elapsedMs: performance.now() - started,
        complete: Object.values(statuses).every((status) =>
          status.done &&
          Object.values(status.relays).every((relay) =>
            relay.state === "complete"
          )
        ),
        statuses,
      };
    } finally {
      clearTimeout(timer);
      // Also cancel the sibling phase if setup or an unexpected stream error throws.
      deadline.abort();
    }
  };
}
