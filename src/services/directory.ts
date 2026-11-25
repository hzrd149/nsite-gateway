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
import { buildIndexedSites } from "../helpers/site-index.ts";
import {
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import { getDailyHits } from "./analytics.ts";
import { getCurationMutedPubkeys } from "./curation.ts";
import { eventStore, getUserProfile } from "./nostr.ts";

const log = logger.extend("directory");

/** Max profiles fetched from relays per rebuild, so startup is gentle */
const PROFILE_WARM_LIMIT = 200;
const PROFILE_WARM_CONCURRENCY = 4;

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
    const content = event && getProfileContent(event);
    const name = content?.display_name || content?.name;
    if (name) profiles.set(pubkey, { name: String(name).slice(0, 64) });
    else missing.push(pubkey);
  }
  return { profiles, missing };
}

async function build(): Promise<Directory> {
  const started = performance.now();
  const sites = buildIndexedSites(
    eventStore.getTimeline({
      kinds: [
        ROOT_SITE_MANIFEST_KIND,
        NAMED_SITE_MANIFEST_KIND,
        MANIFEST_SNAPSHOT_KIND,
      ],
    }),
  );
  const { profiles } = readProfiles(new Set(sites.map((s) => s.pubkey)));
  let dailyHits: Map<string, number[]> | undefined;
  try {
    dailyHits = await getDailyHits(TRENDING_DAYS);
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
  log(
    `Built directory v${current.version}: ${current.stats.sites} sites, ${current.stats.authors} authors in ${
      Math.round(performance.now() - started)
    }ms`,
  );
  return current;
}

/** Rebuilds the directory (coalesces concurrent calls) */
export function rebuildDirectory(): Promise<Directory> {
  building ??= build().finally(() => building = undefined);
  return building;
}

/** Fetches missing author profiles in the background; true if any arrived */
async function warmProfiles(): Promise<boolean> {
  const { missing } = readProfiles(current.authors.keys());
  const queue = missing.slice(0, PROFILE_WARM_LIMIT);
  if (queue.length === 0) return false;

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
  log(`Warmed ${found} of ${missing.length} missing profiles`);
  return found > 0;
}

async function refresh() {
  try {
    await rebuildDirectory();
    if (await warmProfiles()) await rebuildDirectory();
  } catch (error) {
    log("Directory refresh failed", error);
  }
}

let timer: number | undefined;

/** Starts periodic directory rebuilds */
export function startDirectoryService(): void {
  if (timer !== undefined) return;
  void refresh();
  timer = setInterval(() => void refresh(), DIRECTORY_REFRESH * 1000);

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
export async function getCachedPage(
  key: string,
  render: (directory: Directory) => string | Promise<string>,
): Promise<{ body: string; etag: string }> {
  const directory = current;
  const hit = pages.get(key);
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
  pages.set(key, entry);
  return entry;
}
