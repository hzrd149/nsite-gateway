import { getProfileContent, kinds } from "applesauce-core/helpers";
import { CURATION_PUBKEY, DIRECTORY_REFRESH } from "../env.ts";
import logger from "../helpers/debug.ts";
import {
  buildDirectory,
  type Directory,
  type DirectoryProfile,
  TRENDING_DAYS,
} from "../helpers/directory.ts";
import { LruCache } from "../helpers/lru.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import { buildIndexedSites, type IndexedSite } from "../helpers/site-index.ts";
import {
  mergeDirectorySites,
  readDirectorySites,
  replaceDirectorySites,
} from "../helpers/stats-store.ts";
import {
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import { getDailyHits } from "./analytics.ts";
import { getCurationMutedPubkeys } from "./curation.ts";
import {
  eventStore,
  getProfileDisplayName,
  getStoredProfileName,
  getUserProfile,
  hasRelaySyncedThisProcess,
  isProfileCheckFresh,
} from "./nostr.ts";
import { statsDb } from "./stats-db.ts";

const log = logger.extend("directory");

/** Max profiles looked up per refresh, so startup stays gentle on relays */
const PROFILE_WARM_LIMIT = 500;
/** Parallel lookups; the event loader batches them into shared requests */
const PROFILE_WARM_CONCURRENCY = 25;

let version = 0;
let current: Directory = buildDirectory({
  version,
  now: Date.now(),
  sites: [],
});
let building: Promise<Directory> | undefined;

/** Pages rendered from the current directory, keyed by route + query */
const pages = new LruCache<
  string,
  { version: number; body: string; etag: string }
>(
  200,
);

/** Returns the latest directory snapshot. Never does I/O. */
export function getDirectory(): Directory {
  return current;
}

function readProfiles(pubkeys: Iterable<string>) {
  const profiles = new Map<string, DirectoryProfile>();
  const missing: string[] = [];
  for (const pubkey of pubkeys) {
    const event = eventStore.getReplaceable(kinds.Metadata, pubkey);
    const name = getProfileDisplayName(event && getProfileContent(event));
    if (name) profiles.set(pubkey, { name });
    else {
      // Fall back to the last known name, but still look the profile up
      const stored = getStoredProfileName(pubkey);
      if (stored) profiles.set(pubkey, { name: stored });
      missing.push(pubkey);
    }
  }
  return { profiles, missing };
}

/**
 * Sites from the event store. Until relays have been synced in this process,
 * sites saved by earlier runs are included so pages render right after a
 * restart. The result is saved for the next restart.
 */
function loadSites(): IndexedSite[] {
  let sites = buildIndexedSites(
    eventStore.getTimeline({
      kinds: [
        ROOT_SITE_MANIFEST_KIND,
        NAMED_SITE_MANIFEST_KIND,
        MANIFEST_SNAPSHOT_KIND,
      ],
    }),
  );
  try {
    if (!hasRelaySyncedThisProcess()) {
      sites = mergeDirectorySites(sites, readDirectorySites(statsDb));
    }
    replaceDirectorySites(statsDb, sites);
  } catch (error) {
    log("Failed to read or save the directory snapshot", error);
  }
  return sites;
}

function build(): Directory {
  const started = performance.now();
  const sites = loadSites();
  const { profiles } = readProfiles(new Set(sites.map((s) => s.pubkey)));
  let dailyHits: Map<string, number[]> | undefined;
  try {
    dailyHits = getDailyHits(TRENDING_DAYS);
  } catch (error) {
    log("Failed to read daily hits", error);
  }

  current = buildDirectory({
    version: ++version,
    now: Date.now(),
    sites,
    muted: getCurationMutedPubkeys(),
    dailyHits,
    profiles,
  });
  pages.clear();
  searchPages.clear();
  log(
    `Built directory v${current.version}: ${current.stats.sites} sites, ${current.stats.authors} authors in ${
      Math.round(performance.now() - started)
    }ms`,
  );
  return current;
}

/** Rebuilds the directory (coalesces concurrent calls) */
export function rebuildDirectory(): Promise<Directory> {
  building ??= Promise.resolve().then(build).finally(() =>
    building = undefined
  );
  return building;
}

/** Looks up one batch of missing author profiles in the background */
async function warmProfiles(): Promise<{ attempted: number; found: number }> {
  const { missing } = readProfiles(current.authors.keys());
  // Skip pubkeys looked up recently, so authors without a profile anywhere
  // don't hold the front of the queue and block everyone behind them
  const queue = missing
    .filter((pubkey) => !isProfileCheckFresh(pubkey))
    .slice(0, PROFILE_WARM_LIMIT);
  if (queue.length === 0) return { attempted: 0, found: 0 };
  const attempted = queue.length;

  let found = 0;
  const worker = async () => {
    for (let pubkey = queue.shift(); pubkey; pubkey = queue.shift()) {
      try {
        if (await getUserProfile(pubkey, 5_000)) found++;
      } catch {
        // ignore
      }
    }
  };
  await Promise.all(
    Array.from({ length: PROFILE_WARM_CONCURRENCY }, () => worker()),
  );
  log(
    `Warmed ${found} of ${attempted} profiles looked up (${
      missing.length - found
    } authors still without a profile)`,
  );
  return { attempted, found };
}

let refreshing = false;
let refreshQueued = false;

/** Rebuilds the directory, then looks up missing author profiles */
export async function refreshDirectory(): Promise<void> {
  // A slow profile warm-up must not overlap another refresh; run once more
  // afterwards so sites synced in the meantime still get their profiles
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    await rebuildDirectory();
    // Keep warming in batches until every missing profile has been looked up
    // once; looked-up pubkeys are skipped for PROFILES_STALE_TIME, so this ends
    for (;;) {
      const { attempted, found } = await warmProfiles();
      if (found > 0) await rebuildDirectory();
      if (attempted === 0) break;
    }
  } catch (error) {
    log("Directory refresh failed", error);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshDirectory();
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Starts periodic directory rebuilds */
export function startDirectoryService(): void {
  if (timer !== undefined) return;
  void refreshDirectory();
  timer = setInterval(() => void refreshDirectory(), DIRECTORY_REFRESH * 1000);

  // Apply curator mute list changes immediately
  const curation = CURATION_PUBKEY
    ? eventStore
      .filters({ kinds: [kinds.Mutelist], authors: [CURATION_PUBKEY] })
      .subscribe(() => void rebuildDirectory())
    : undefined;

  onShutdown(() => {
    clearInterval(timer);
    curation?.unsubscribe();
    return Promise.resolve();
  });
}

/**
 * Returns a cached rendering of a page for the current directory version,
 * rendering it on a miss. Rendering must be synchronous and side-effect free.
 */
/** Search result pages get their own cache so queries can't evict pages */
const searchPages = new LruCache<
  string,
  { version: number; body: string; etag: string }
>(500);

export async function getCachedPage(
  key: string,
  render: (directory: Directory) => string | Promise<string>,
  cache: "pages" | "search" = "pages",
): Promise<{ body: string; etag: string }> {
  const directory = current;
  const store = cache === "search" ? searchPages : pages;
  const hit = store.get(key);
  if (hit && hit.version === directory.version) return hit;

  const body = await render(directory);
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(body),
  );
  const etag = `"${
    Array.from(new Uint8Array(hash).slice(0, 12), (b) =>
      b.toString(16).padStart(2, "0")).join("")
  }"`;
  const entry = { version: directory.version, body, etag };
  store.set(key, entry);
  return entry;
}
