import { mergeBlossomServers } from "applesauce-common/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { BLOSSOM_PROXY, BLOSSOM_SERVERS } from "../env.ts";
import logger from "../helpers/debug.ts";
import { logValue } from "../helpers/request-log.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import {
  type WarmupJob,
  type WarmupOutcome,
  WarmupRegistry,
} from "../helpers/site-loading.ts";
import {
  getManifestServers,
  resolveManifestPath,
} from "../helpers/site-manifest.ts";
import { streamBlob, verifiedBlobCache } from "./blossom.ts";
import {
  getCachedManifest,
  getManifest,
  getUserBlossomServers,
} from "./nostr.ts";

const log = logger.extend("warmup");

/** How long a warm-up may keep working after the browser got the loading page */
const WARMUP_TIMEOUT = 60_000;

/**
 * At most this many warm-ups run at once. A warm-up keeps working after the
 * browser leaves, so the cap stops clients that hang up right away from
 * queueing unbounded relay and Blossom work; over the cap, requests fall back
 * to the blocking path and must hold their connection like before.
 */
const MAX_RUNNING_WARMUPS = 64;

const warmups = new WarmupRegistry({
  maxSize: 1000,
  maxRunning: MAX_RUNNING_WARMUPS,
  failureTtl: 15_000,
});

/** Registry key for one path of one site */
export function siteWarmupKey(
  site: ResolvedSiteAddress,
  pathname: string,
): string {
  const address = site.type === "snapshot"
    ? site.id
    : `${site.kind}:${site.pubkey}:${site.identifier}`;
  return `${address}${pathname}`;
}

/** Blossom servers to fill a manifest's blobs from, most preferred first */
export function getSiteBlobServers(
  manifest: NostrEvent,
  userServers?: string[],
): string[] {
  return mergeBlossomServers(
    getManifestServers(manifest),
    userServers,
    BLOSSOM_SERVERS,
  );
}

/**
 * True when a request for this path can be answered without network I/O:
 * the manifest is in the event store and the file (if any) is verified on
 * disk. A path missing from a cached manifest is ready (it renders a 404).
 */
export function isSiteFileReady(
  site: ResolvedSiteAddress,
  pathname: string,
): boolean {
  const manifest = getCachedManifest(site);
  if (!manifest) return false;
  const match = resolveManifestPath(manifest, pathname);
  return !match || verifiedBlobCache.has(match.sha256);
}

/** Returns the running or recently finished warm-up for this path */
export function getSiteWarmup(key: string): WarmupJob | undefined {
  return warmups.get(key);
}

/** Returns a recent failed warm-up outcome for this path */
export function getSiteWarmupFailure(key: string): WarmupOutcome | undefined {
  return warmups.getFailure(key);
}

/**
 * Starts (or joins) a background fetch of the manifest and the file for this
 * path. It runs on its own timeout, not the request's signal, so it keeps
 * filling the cache after the browser has received the loading page. Returns
 * undefined when too many warm-ups are already running.
 */
export function warmSiteFile(
  site: ResolvedSiteAddress,
  pathname: string,
): WarmupJob | undefined {
  const key = siteWarmupKey(site, pathname);
  return warmups.start(key, async (setStage) => {
    const signal = AbortSignal.timeout(WARMUP_TIMEOUT);

    const manifest = await getManifest(site, 10_000);
    if (!manifest) return "no-manifest";

    const match = resolveManifestPath(manifest, pathname);
    if (!match || verifiedBlobCache.has(match.sha256)) return "ready";

    setStage("servers");
    const userServers = await getUserBlossomServers(manifest.pubkey, 10_000);

    setStage("blob");
    try {
      const response = await streamBlob(
        match.sha256,
        getSiteBlobServers(manifest, userServers),
        {
          method: "HEAD",
          pubkey: manifest.pubkey,
          blossomProxy: BLOSSOM_PROXY,
          signal,
        },
      );
      await response?.body?.cancel();
      if (!response) return "unavailable";
      // A busy verified cache (503) is not a failure of this site: let the
      // reload take the normal path and receive the cache's own retry answer.
      return response.status < 500 || response.status === 503
        ? "ready"
        : "unavailable";
    } catch (error) {
      log("Warm-up of %s failed: %s", key, logValue(error));
      return "unavailable";
    }
  });
}
