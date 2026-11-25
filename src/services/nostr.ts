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
import { type Subscription, takeUntil, timer } from "rxjs";
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

export function syncNsiteEvents(
  relays = NOSTR_RELAYS,
  options: NsiteSyncOptions = {},
) {
  const until = options.until ?? Math.floor(Date.now() / 1000);
  return sync(relays, {
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
      eventStore.add(response);
    },
    error: (error) => {
      console.error("Live relay sync failed", error);
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

/** Gets a user's profile */
export async function getUserProfile(
  pubkey: string,
  timeout = 5_000,
): Promise<ProfileContent | undefined> {
  const checked = profilesChecked.get(pubkey);
  const fresh = checked &&
    checked.getTime() > Date.now() - PROFILES_STALE_TIME * 1000;

  // check in-memory cache
  const cached = eventStore.getReplaceable(kinds.Metadata, pubkey);

  // If results are fresh, return whatever is in the event store
  if (fresh) return cached && getProfileContent(cached);

  log(`Fetching profile for ${pubkey}`);

  // Otherwise, fetch the latest profile
  const user = castUser(pubkey, eventStore);
  const profile = await firstValueFrom(
    user.profile$.metadata.pipe(takeUntil(timer(timeout))),
    {
      defaultValue: undefined,
    },
  );

  // Set the last checked time
  profilesChecked.set(pubkey, new Date());

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

/** Loads a replaceable site manifest event from the store */
export async function getReplaceableManifest(
  address: ReplaceableSiteAddress,
  timeout = 5_000,
) {
  const manifest = eventStore.getReplaceable(
    address.kind,
    address.pubkey,
    address.identifier,
  );
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
  const cached = eventStore
    .getTimeline({ kinds: [MANIFEST_SNAPSHOT_KIND] })
    .find((event) => event.id === snapshot.id);
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
