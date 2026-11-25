import { castUser } from "applesauce-common/casts";
import { BLOSSOM_SERVER_LIST_KIND } from "applesauce-common/helpers";
import { getBlossomServers } from "../helpers/blossom.ts";
import { EventStore, firstValueFrom, lastValueFrom } from "applesauce-core";
import {
  getInboxes,
  getOutboxes,
  getProfileContent,
  getReplaceableAddressFromPointer,
  kinds,
  persistEventsToCache,
  type ProfileContent,
  relaySet,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { filter, type Subscription, takeUntil, timer } from "rxjs";
import {
  CACHE_RELAYS,
  LOOKUP_RELAYS,
  NOSTR_RELAYS,
  OUTBOXES_STALE_TIME,
  PROFILES_STALE_TIME,
  RELAY_SYNC_CONFIG,
  SERVERS_STALE_TIME,
} from "../env.ts";
import logger from "../helpers/debug.ts";
import {
  getMeta,
  readProfiles,
  setMeta,
  upsertProfiles,
} from "../helpers/stats-store.ts";
import { logValue } from "../helpers/request-log.ts";
import { formatAgeFromUnix } from "../helpers/format.ts";
import {
  createNsiteSync,
  NSITE_SYNC_FILTERS,
  type NsiteSyncOptions,
} from "../helpers/nsite-sync.ts";
import type {
  ReplaceableSiteAddress,
  ResolvedSiteAddress,
  SnapshotSiteAddress,
} from "../helpers/resolved-site.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import {
  getManifestIdentifier,
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import { statsDb } from "./stats-db.ts";

const log = logger.extend("nostr");

export const pool = new RelayPool();

export const eventStore = new EventStore();
const syncAbort = new AbortController();
const sync = createNsiteSync({ eventStore, pool });

// Setup debug logging for incoming nostr events
eventStore.filters({ kinds: [BLOSSOM_SERVER_LIST_KIND] }).subscribe((list) => {
  const servers = getBlossomServers(list.tags);
  log(
    `Found ${servers.length} blossom servers for ${list.pubkey}, id=${list.id}, age=${
      formatAgeFromUnix(
        list.created_at,
      )
    }\n`,
    servers.join(", "),
  );
});
eventStore.filters({ kinds: [kinds.RelayList] }).subscribe((list) => {
  const inboxes = getInboxes(list);
  const outboxes = getOutboxes(list);
  log(
    `Found ${
      outboxes.length + inboxes.length
    } relays for ${list.pubkey}, id=${list.id}, age=${
      formatAgeFromUnix(
        list.created_at,
      )
    }\n`,
    inboxes.join(", "),
    "\n",
    outboxes.join(", "),
  );
});

onShutdown(() => {
  console.log("Shutting down Nostr service");
  syncAbort.abort();
  for (const [, relay] of pool.relays) relay.close();
  return Promise.resolve();
});

/** Create generic single event loader for the event store */
export const eventLoader = createEventLoaderForStore(eventStore, pool, {
  bufferTime: 500,
  lookupRelays: LOOKUP_RELAYS,
  extraRelays: relaySet(NOSTR_RELAYS),
});

/** Persisted across restarts so /health and status pages show the true time */
let lastRelaySync: number | undefined = Number(
  getMeta(statsDb, "last_relay_sync"),
) || undefined;
let lastRelaySyncSaved = 0;
/** True once a relay sync finished in this process (not restored from disk) */
let relaySyncedThisProcess = false;

/** Unix ms of the last completed relay sync (or last live event) */
export function getLastRelaySync(): number | undefined {
  return lastRelaySync;
}

/** True once relays have been synced since this process started */
export function hasRelaySyncedThisProcess(): boolean {
  return relaySyncedThisProcess;
}

function markRelaySync(completed = false): void {
  lastRelaySync = Date.now();
  if (completed) relaySyncedThisProcess = true;
  // Live events can arrive quickly; write at most every 10 seconds
  if (completed || lastRelaySync - lastRelaySyncSaved >= 10_000) {
    lastRelaySyncSaved = lastRelaySync;
    try {
      setMeta(statsDb, "last_relay_sync", String(lastRelaySync));
    } catch (error) {
      log("Failed to save last relay sync", error);
    }
  }
}

export async function syncNsiteEvents(
  relays = NOSTR_RELAYS,
  options: NsiteSyncOptions = {},
) {
  const until = options.until ?? Math.floor(Date.now() / 1000);
  const result = await sync(relays, {
    totalTimeout: RELAY_SYNC_CONFIG.totalTimeoutMs,
    timeout: RELAY_SYNC_CONFIG.progressTimeoutMs,
    ...(RELAY_SYNC_CONFIG.lookbackSeconds > 0
      ? { since: Math.max(0, until - RELAY_SYNC_CONFIG.lookbackSeconds) }
      : {}),
    ...options,
    until,
    signal: options.signal
      ? AbortSignal.any([syncAbort.signal, options.signal])
      : syncAbort.signal,
  });
  markRelaySync(true);
  return result;
}

export function subscribeNsiteEvents(
  relays = NOSTR_RELAYS,
  since = Math.floor(Date.now() / 1000),
): Subscription {
  return pool.subscription(
    relays,
    [
      { ...NSITE_SYNC_FILTERS.manifests, since },
      { ...NSITE_SYNC_FILTERS.deletes, since },
    ],
    {
      id: "nsite-live-sync",
      reconnect: Infinity,
      resubscribe: true,
    },
  ).subscribe({
    next: (response) => {
      if (typeof response === "string") {
        // EOSE: initial sync with the relays is complete
        markRelaySync(true);
        return;
      }
      eventStore.add(response);
      markRelaySync();
    },
    error: (error) => {
      console.error(`Live relay sync failed: ${logValue(error)}`);
    },
  });
}

if (CACHE_RELAYS) {
  log(`Using cache relays: ${CACHE_RELAYS.join(", ")}`);

  // Persist all new events to local cache relay
  persistEventsToCache(eventStore, async (events) => {
    await Promise.allSettled(
      events.map((event) => pool.publish(CACHE_RELAYS!, event)),
    );
  });
}

const profilesChecked = new Map<string, Date>();
/** Last known display names, persisted so directory pages have them at startup */
const storedProfileNames = new Map<string, string>();

// Restore profile names and recent lookup times from the stats database
try {
  const staleBefore = Date.now() - PROFILES_STALE_TIME * 1000;
  for (const row of readProfiles(statsDb)) {
    if (row.name) storedProfileNames.set(row.pubkey, row.name);
    if (row.checkedAt > staleBefore) {
      profilesChecked.set(row.pubkey, new Date(row.checkedAt));
    }
  }
} catch (error) {
  log("Failed to load stored profiles", error);
}

/** Display name for a profile: display_name, then name, at most 64 characters */
export function getProfileDisplayName(
  content: ProfileContent | undefined,
): string | undefined {
  const name = content?.display_name || content?.name;
  return name ? String(name).slice(0, 64) : undefined;
}

/** Last known display name, from the event store or the stats database */
export function getStoredProfileName(pubkey: string): string | undefined {
  return storedProfileNames.get(pubkey);
}

/** Gets a user's profile */
/** True if the profile was looked up within PROFILES_STALE_TIME */
export function isProfileCheckFresh(pubkey: string): boolean {
  const checked = profilesChecked.get(pubkey);
  return !!checked &&
    checked.getTime() > Date.now() - PROFILES_STALE_TIME * 1000;
}

export async function getUserProfile(
  pubkey: string,
  timeout = 5_000,
): Promise<ProfileContent | undefined> {
  const fresh = isProfileCheckFresh(pubkey);

  // check in-memory cache
  const cached = eventStore.getReplaceable(kinds.Metadata, pubkey);

  // If results are fresh, return whatever is in the event store
  if (fresh) return cached && getProfileContent(cached);

  log(`Fetching profile for ${pubkey}`);

  // Otherwise, fetch the latest profile
  const user = castUser(pubkey, eventStore);
  // The stream emits undefined while the loader is still fetching, so wait for
  // the first real profile (or the timeout) instead of taking that placeholder
  const profile = await firstValueFrom(
    user.profile$.metadata.pipe(
      filter((metadata) => metadata !== undefined),
      takeUntil(timer(timeout)),
    ),
    {
      defaultValue: undefined,
    },
  );

  // Set the last checked time
  const checked = new Date();
  profilesChecked.set(pubkey, checked);
  const name = getProfileDisplayName(profile);
  if (name) storedProfileNames.set(pubkey, name);
  try {
    upsertProfiles(statsDb, [{ pubkey, name, checkedAt: checked.getTime() }]);
  } catch (error) {
    log("Failed to save profile lookup", error);
  }

  return profile;
}

const outboxesChecked = new Map<string, Date>();

/** Gets a user's outbox relays */
export async function getUserOutboxes(
  pubkey: string,
  timeout = 5_000,
): Promise<string[] | undefined> {
  const checked = outboxesChecked.get(pubkey);
  const cached = eventStore.getReplaceable(kinds.RelayList, pubkey);
  const fresh = checked &&
    checked.getTime() > Date.now() - OUTBOXES_STALE_TIME * 1000;

  // If results are fresh, return whatever is in the event store
  if (fresh) return cached && getOutboxes(cached);

  log(`Fetching outboxes for ${pubkey}`);

  // Otherwise, fetch the latest outboxes
  const user = castUser(pubkey, eventStore);
  const outboxes = await lastValueFrom(
    user.outboxes$.pipe(
      // Add hard timeout
      takeUntil(timer(timeout)),
    ),
    { defaultValue: undefined },
  );

  // Set the last checked time
  outboxesChecked.set(pubkey, new Date());

  return outboxes;
}

const blossomServersChecked = new Map<string, Date>();

/** Gets a users list of blossom servers */
export async function getUserBlossomServers(pubkey: string, timeout = 5_000) {
  const checked = blossomServersChecked.get(pubkey);
  const fresh = checked &&
    checked.getTime() > Date.now() - SERVERS_STALE_TIME * 1000;

  const cached = eventStore.getReplaceable(BLOSSOM_SERVER_LIST_KIND, pubkey);

  // If results are fresh, return whatever is in the event store
  if (fresh) {
    return cached && getBlossomServers(cached.tags);
  }

  log(`Fetching blossom servers for ${pubkey}`);

  // Otherwise, fetch the latest blossom servers
  const user = castUser(pubkey, eventStore);
  const servers = await lastValueFrom(
    user.blossomServers$.pipe(
      // Add hard timeout
      takeUntil(timer(timeout)),
    ),
    { defaultValue: undefined },
  );

  // Set the last checked time
  blossomServersChecked.set(pubkey, new Date());

  return servers?.map((server) => server.toString());
}

/** Returns a site manifest already in the event store, without network I/O */
export function getCachedManifest(
  address: ResolvedSiteAddress,
): NostrEvent | undefined {
  if (address.type === "snapshot") {
    return eventStore
      .getTimeline({ kinds: [MANIFEST_SNAPSHOT_KIND] })
      .find((event) => event.id === address.id);
  }

  return eventStore.getReplaceable(
    address.kind,
    address.pubkey,
    address.identifier,
  );
}

/** Loads a replaceable site manifest event from the store */
export async function getReplaceableManifest(
  address: ReplaceableSiteAddress,
  timeout = 5_000,
) {
  const manifest = getCachedManifest(address);
  if (manifest) return manifest;

  log(`Loading manifest ${getReplaceableAddressFromPointer(address)}`);

  const outboxes = await getUserOutboxes(address.pubkey, timeout);
  const relays = relaySet(outboxes, address.relays);

  log(
    `Loading manifest ${getReplaceableAddressFromPointer(address)} from ${
      relays.join(", ")
    }`,
  );
  return await lastValueFrom(
    eventLoader(
      // Load the address pointer from the outboxes and default relays
      { ...address, relays: relaySet(relays), cache: false },
    ).pipe(
      // Add hard timeout
      takeUntil(timer(timeout)),
    ),
    { defaultValue: undefined },
  );
}

/** Loads a snapshot manifest event by id */
export async function getSnapshotManifest(
  snapshot: SnapshotSiteAddress,
  timeout = 5_000,
) {
  const cached = getCachedManifest(snapshot);
  if (cached) return cached;

  const relays = relaySet(CACHE_RELAYS, LOOKUP_RELAYS, NOSTR_RELAYS);
  if (relays.length === 0) return undefined;

  log(
    `Loading snapshot manifest ${snapshot.id} from ${relays.join(", ")}`,
  );

  return await lastValueFrom(
    eventLoader(
      { ...snapshot, relays: relaySet(relays), cache: false },
    ).pipe(
      takeUntil(timer(timeout)),
    ),
    { defaultValue: undefined },
  );
}

/** Loads any supported site manifest event */
export async function getManifest(
  address: ResolvedSiteAddress,
  timeout = 5_000,
) {
  if (address.type === "snapshot") {
    return await getSnapshotManifest(address, timeout);
  }

  return await getReplaceableManifest(address, timeout);
}

export function isMatchingManifestAddress(
  event: NostrEvent,
  pubkey: string,
  identifier: string,
): boolean {
  if (event.pubkey !== pubkey) return false;

  if (identifier === "") {
    return event.kind === ROOT_SITE_MANIFEST_KIND &&
      getManifestIdentifier(event) === undefined;
  }

  return event.kind === NAMED_SITE_MANIFEST_KIND &&
    getManifestIdentifier(event) === identifier;
}
