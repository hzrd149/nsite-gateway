import { castUser } from "applesauce-common/casts";
import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
} from "applesauce-common/helpers";
import { EventStore, firstValueFrom, lastValueFrom } from "applesauce-core";
import {
  type AddressPointer,
  getInboxes,
  getOutboxes,
  getProfileContent,
  getReplaceableAddressFromPointer,
  kinds,
  type NostrEvent,
  persistEventsToCache,
  ProfileContent,
  relaySet,
} from "applesauce-core/helpers";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { map, takeUntil, timer } from "rxjs";
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
import { onShutdown } from "../helpers/shutdown.ts";
import {
  getManifestIdentifier,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import * as cache from "../services/cache.ts";

const log = logger.extend("nostr");

const SITE_MANIFEST_KINDS = [ROOT_SITE_MANIFEST_KIND, NAMED_SITE_MANIFEST_KIND];

export const pool = new RelayPool();

export const eventStore = new EventStore();

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

onShutdown(async () => {
  console.log("Shutting down Nostr service");
  for (const [, relay] of pool.relays) relay.close();
});

/** Create generic single event loader for the event store */
export const eventLoader = createEventLoaderForStore(eventStore, pool, {
  bufferTime: 500,
  lookupRelays: LOOKUP_RELAYS,
  extraRelays: relaySet(NOSTR_RELAYS),
});

function getLatestSiteManifestCreatedAt(): number | undefined {
  const manifests = eventStore.getTimeline({ kinds: SITE_MANIFEST_KINDS });

  if (manifests.length === 0) return undefined;

  let latest = manifests[0].created_at;

  for (let i = 1; i < manifests.length; i++) {
    if (manifests[i].created_at > latest) latest = manifests[i].created_at;
  }

  return latest;
}

export async function syncSiteManifests(
  relays = NOSTR_RELAYS,
): Promise<number> {
  if (!relays || relays.length === 0) return 0;

  const latestCreatedAt = getLatestSiteManifestCreatedAt();
  const since = latestCreatedAt === undefined ? undefined : latestCreatedAt + 1;

  return await new Promise((resolve, reject) => {
    let found = 0;

    pool
      .request(relays, {
        kinds: SITE_MANIFEST_KINDS,
        ...(since === undefined ? {} : { since }),
      })
      .subscribe({
        next: (event) => {
          const insert = eventStore.add(event);
          if (insert && insert === event) found++;
        },
        error: reject,
        complete: () => resolve(found),
      });
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
  const stale = checked &&
    checked.getTime() > Date.now() - PROFILES_STALE_TIME * 1000;

  // check in-memory cache
  const cached = eventStore.getReplaceable(kinds.Metadata, pubkey);

  // If results are fresh, return whatever is in the event store
  if (!stale) return cached && getProfileContent(cached);

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
  const stale = checked &&
    checked.getTime() > Date.now() - OUTBOXES_STALE_TIME * 1000;
  const cached = eventStore.getReplaceable(kinds.RelayList, pubkey);

  // If results are fresh, return whatever is in the event store
  if (!stale) return cached && getOutboxes(cached);

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
  const stale = checked &&
    checked.getTime() > Date.now() - SERVERS_STALE_TIME * 1000;

  const cached = eventStore.getReplaceable(BLOSSOM_SERVER_LIST_KIND, pubkey);

  // If results are fresh, return whatever is in the event store
  if (!stale) {
    return cached && getBlossomServersFromList(cached).map((s) => s.toString());
  }

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

/** Loads a site manifest event from the store */
export async function getManifest(address: AddressPointer, timeout = 5_000) {
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
