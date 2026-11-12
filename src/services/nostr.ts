import { castUser } from "applesauce-common/casts";
import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
} from "applesauce-common/helpers";
import { EventStore, firstValueFrom, lastValueFrom } from "applesauce-core";
import {
  type Filter,
  getInboxes,
  getOutboxes,
  getProfileContent,
  getReplaceableAddressFromPointer,
  kinds,
  persistEventsToCache,
  type ProfileContent,
  relaySet,
  verifyEvent,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import {
  createEventLoader,
  createEventLoaderForStore,
} from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { type Subscription, takeUntil, timer, toArray } from "rxjs";
import {
  CACHE_RELAYS,
  LOOKUP_RELAYS,
  NOSTR_RELAYS,
  OUTBOXES_STALE_TIME,
  PROFILES_STALE_TIME,
  SERVERS_STALE_TIME,
} from "../env.ts";
import logger from "../helpers/debug.ts";
import { formatAgeFromUnix } from "../helpers/format.ts";
import { CANONICAL_SITE_IDENTIFIER } from "../helpers/nsite-host.ts";
import type {
  EventSiteAddress,
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

const DELETE_EVENT_KIND = 5;

const SITE_MANIFEST_KINDS = [
  ROOT_SITE_MANIFEST_KIND,
  NAMED_SITE_MANIFEST_KIND,
  MANIFEST_SNAPSHOT_KIND,
];

export const pool = new RelayPool();

// Retain replaceable history so an exact event pointer cannot be changed into
// a request for the current version. Every inserted event is still verified.
export const eventStore = new EventStore({
  keepOldVersions: true,
  verifyEvent,
});

// Setup debug logging for incoming nostr events
eventStore.filters({ kinds: [BLOSSOM_SERVER_LIST_KIND] }).subscribe((list) => {
  const servers = getBlossomServersFromList(list);
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
  for (const [, relay] of pool.relays) relay.close();
  return Promise.resolve();
});

/** Create generic single event loader for the event store */
export const eventLoader = createEventLoaderForStore(eventStore, pool, {
  bufferTime: 500,
  lookupRelays: LOOKUP_RELAYS,
  extraRelays: relaySet(NOSTR_RELAYS),
});

// Exact and current selection need the original events, not the event store's
// replacement projection. The store remains useful for models and discovery.
const exactEventLoader = createEventLoader(pool, {
  bufferTime: 500,
  eventStore: null,
  extraRelays: relaySet(CACHE_RELAYS, LOOKUP_RELAYS, NOSTR_RELAYS),
});

const exactManifestEvents = new Map<string, NostrEvent>();
const currentManifestEvents = new Map<string, Map<string, NostrEvent>>();
const currentManifestChecked = new Map<string, number>();
const CURRENT_MANIFEST_STALE_TIME_MS = 60_000;

function getLatestSiteManifestCreatedAt(): number | undefined {
  const manifests = eventStore.getTimeline({ kinds: SITE_MANIFEST_KINDS });

  if (manifests.length === 0) return undefined;

  let latest = manifests[0].created_at;

  for (let i = 1; i < manifests.length; i++) {
    if (manifests[i].created_at > latest) latest = manifests[i].created_at;
  }

  return latest;
}

function getLatestSiteDeleteCreatedAt(): number | undefined {
  const deletes = eventStore.getTimeline({ kinds: [DELETE_EVENT_KIND] });
  return deletes[0]?.created_at;
}

async function requestAndStoreEvents(
  relays: string[],
  filter: Filter,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    let found = 0;

    pool.request(relays, filter).subscribe({
      next: (event) => {
        rememberManifestEvent(event);
        const insert = eventStore.add(event);
        if (insert && insert === event) found++;
      },
      error: reject,
      complete: () => resolve(found),
    });
  });
}

export async function syncSiteManifests(
  relays = NOSTR_RELAYS,
): Promise<number> {
  if (!relays || relays.length === 0) return 0;

  const latestCreatedAt = getLatestSiteManifestCreatedAt();
  const since = latestCreatedAt === undefined ? undefined : latestCreatedAt + 1;

  return await requestAndStoreEvents(relays, {
    kinds: SITE_MANIFEST_KINDS,
    ...(since === undefined ? {} : { since }),
  });
}

export async function syncSiteManifestDeletes(
  relays = NOSTR_RELAYS,
): Promise<number> {
  if (!relays || relays.length === 0) return 0;

  const latestCreatedAt = getLatestSiteDeleteCreatedAt();
  const since = latestCreatedAt === undefined ? undefined : latestCreatedAt + 1;

  return await requestAndStoreEvents(relays, {
    // Get delete events
    kinds: [DELETE_EVENT_KIND],
    // Filter for delete events targeting nsite kinds
    "#k": SITE_MANIFEST_KINDS.map((kind) => String(kind)),
    ...(since === undefined ? {} : { since }),
  });
}

export async function syncNsiteEvents(relays = NOSTR_RELAYS): Promise<{
  manifests: number;
  deletes: number;
}> {
  const manifests = await syncSiteManifests(relays);
  const deletes = await syncSiteManifestDeletes(relays);

  return { manifests, deletes };
}

export function subscribeNsiteEvents(relays = NOSTR_RELAYS): Subscription {
  return pool.subscription(
    relays,
    [
      { kinds: SITE_MANIFEST_KINDS },
      {
        kinds: [DELETE_EVENT_KIND],
        "#k": SITE_MANIFEST_KINDS.map((kind) => String(kind)),
      },
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
    return cached && getBlossomServersFromList(cached).map((s) => s.toString());
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

/** Loads a replaceable site manifest, refreshing stale current selections. */
export async function getReplaceableManifest(
  address: ReplaceableSiteAddress,
  timeout = 5_000,
  forceRefresh = false,
) {
  const key = currentAddressKey(address);
  const checked = currentManifestChecked.get(key) ?? 0;
  const fresh = Date.now() - checked < CURRENT_MANIFEST_STALE_TIME_MS;
  const stored = getCurrentManifestCandidates(address);
  if (!forceRefresh && fresh && stored.length > 0) {
    const selected = selectCurrentManifest(stored, address);
    if (selected) return selected;
  }

  log(`Loading manifest ${getReplaceableAddressFromPointer(address)}`);

  const outboxes = await getUserOutboxes(address.pubkey, timeout);
  const relays = relaySet(
    outboxes,
    address.relays,
    CACHE_RELAYS,
    LOOKUP_RELAYS,
    NOSTR_RELAYS,
  );

  log(
    `Loading manifest ${getReplaceableAddressFromPointer(address)} from ${
      relays.join(", ")
    }`,
  );
  const filter = address.kind === ROOT_SITE_MANIFEST_KIND
    ? { kinds: [address.kind], authors: [address.pubkey] }
    : {
      kinds: [address.kind],
      authors: [address.pubkey],
      "#d": [address.identifier],
    };
  // Query the complete discovery set. A response from one relay must not stop
  // discovery of a newer replaceable event on another relay.
  const loaded = await lastValueFrom(
    pool.request(relays, filter).pipe(
      takeUntil(timer(timeout)),
      toArray(),
    ),
    { defaultValue: [] as NostrEvent[] },
  );
  const candidates = loaded.filter((event) =>
    isCurrentManifestCandidate(event, address) && verifyEvent(event)
  );
  for (const event of candidates) {
    rememberManifestEvent(event);
    eventStore.add(event);
  }
  if (candidates.length > 0) currentManifestChecked.set(key, Date.now());

  // An empty refresh cannot resurrect an expired current selection. A still
  // fresh cached value remains usable for its explicitly bounded lifetime.
  if (candidates.length === 0 && !fresh) return undefined;
  return selectCurrentManifest(getCurrentManifestCandidates(address), address);
}

function currentAddressKey(address: ReplaceableSiteAddress): string {
  return `${address.kind}:${address.pubkey}:${address.identifier}`;
}

function isCurrentManifestCandidate(
  event: NostrEvent,
  address: ReplaceableSiteAddress,
): boolean {
  if (event.kind !== address.kind || event.pubkey !== address.pubkey) {
    return false;
  }
  return address.kind === ROOT_SITE_MANIFEST_KIND ||
    getManifestIdentifier(event) === address.identifier;
}

function rememberManifestEvent(event: NostrEvent): void {
  if (!SITE_MANIFEST_KINDS.includes(event.kind) || !verifyEvent(event)) return;
  exactManifestEvents.set(event.id, event);

  if (event.kind === MANIFEST_SNAPSHOT_KIND) return;
  const address: ReplaceableSiteAddress = {
    type: "replaceable",
    kind: event.kind,
    pubkey: event.pubkey,
    identifier: event.kind === ROOT_SITE_MANIFEST_KIND
      ? ""
      : getManifestIdentifier(event) ?? "",
  };
  const key = currentAddressKey(address);
  const events = currentManifestEvents.get(key) ??
    new Map<string, NostrEvent>();
  events.set(event.id, event);
  currentManifestEvents.set(key, events);
}

function getCurrentManifestCandidates(
  address: ReplaceableSiteAddress,
): NostrEvent[] {
  const events = new Map<string, NostrEvent>(
    currentManifestEvents.get(currentAddressKey(address)),
  );
  for (
    const event of eventStore.getTimeline({
      kinds: [address.kind],
      authors: [address.pubkey],
    })
  ) {
    if (isCurrentManifestCandidate(event, address) && verifyEvent(event)) {
      events.set(event.id, event);
    }
  }
  return [...events.values()];
}

/** Select current by NIP-01 ordering, then validate the winning manifest. */
export function selectCurrentManifest(
  events: NostrEvent[],
  address: ReplaceableSiteAddress,
): NostrEvent | undefined {
  const candidates = events.filter((event) =>
    isCurrentManifestCandidate(event, address) && verifyEvent(event)
  ).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const selected = candidates[0];
  return selected && isMatchingReplaceableManifest(selected, address)
    ? selected
    : undefined;
}

/** Checks the id, hints, kind, and site identity of an exact manifest event. */
export function isMatchingManifestEvent(
  event: NostrEvent,
  pointer: EventSiteAddress | SnapshotSiteAddress,
): boolean {
  if (event.id !== pointer.id) return false;
  if (pointer.author !== undefined && event.pubkey !== pointer.author) {
    return false;
  }
  if (pointer.kind !== undefined && event.kind !== pointer.kind) return false;
  if (pointer.type === "snapshot" && event.kind !== MANIFEST_SNAPSHOT_KIND) {
    return false;
  }
  if (!SITE_MANIFEST_KINDS.includes(event.kind)) return false;

  const identifiers = event.tags.filter((tag) => tag[0] === "d");
  if (event.kind === ROOT_SITE_MANIFEST_KIND) return identifiers.length === 0;
  if (event.kind === NAMED_SITE_MANIFEST_KIND) {
    return identifiers.length === 1 &&
      CANONICAL_SITE_IDENTIFIER.test(identifiers[0]?.[1] ?? "");
  }

  return true;
}

/** Loads an exact root, named, or snapshot manifest event by id. */
export async function getEventManifest(
  pointer: EventSiteAddress | SnapshotSiteAddress,
  timeout = 5_000,
) {
  const cached = exactManifestEvents.get(pointer.id) ??
    eventStore.getEvent(pointer.id);
  if (cached) {
    return verifyEvent(cached) && isMatchingManifestEvent(cached, pointer)
      ? cached
      : undefined;
  }

  const relays = relaySet(
    pointer.relays,
    CACHE_RELAYS,
    LOOKUP_RELAYS,
    NOSTR_RELAYS,
  );
  if (relays.length === 0) return undefined;

  log(`Loading manifest event ${pointer.id} from ${relays.join(", ")}`);

  const loaded = await lastValueFrom(
    exactEventLoader(
      { ...pointer, relays, cache: false },
    ).pipe(
      takeUntil(timer(timeout)),
    ),
    { defaultValue: undefined },
  );
  if (
    !loaded || !verifyEvent(loaded) ||
    !isMatchingManifestEvent(loaded, pointer)
  ) {
    return undefined;
  }
  rememberManifestEvent(loaded);
  eventStore.add(loaded);
  return loaded;
}

/** Loads a canonical snapshot manifest event by id. */
export async function getSnapshotManifest(
  snapshot: SnapshotSiteAddress,
  timeout = 5_000,
) {
  return await getEventManifest(snapshot, timeout);
}

/** Loads any supported site manifest event */
export async function getManifest(
  address: ResolvedSiteAddress,
  timeout = 5_000,
  forceRefresh = false,
) {
  if (address.type !== "replaceable") {
    return await getEventManifest(address, timeout);
  }

  return await getReplaceableManifest(address, timeout, forceRefresh);
}

export function isMatchingManifestAddress(
  event: NostrEvent,
  pubkey: string,
  identifier: string,
): boolean {
  if (event.pubkey !== pubkey) return false;

  if (identifier === "") {
    return event.kind === ROOT_SITE_MANIFEST_KIND &&
      !event.tags.some((tag) => tag[0] === "d");
  }

  return event.kind === NAMED_SITE_MANIFEST_KIND &&
    event.tags.filter((tag) => tag[0] === "d").length === 1 &&
    CANONICAL_SITE_IDENTIFIER.test(identifier) &&
    getManifestIdentifier(event) === identifier;
}

function isMatchingReplaceableManifest(
  event: NostrEvent,
  address: ReplaceableSiteAddress,
): boolean {
  return event.kind === address.kind &&
    isMatchingManifestAddress(event, address.pubkey, address.identifier);
}
