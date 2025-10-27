import { EventStore, lastValueFrom, mapEventsToStore, mapEventsToTimeline } from "applesauce-core";
import { BLOSSOM_SERVER_LIST_KIND, getBlossomServersFromList, getOutboxes } from "applesauce-core/helpers";
import { createAddressLoader, createEventLoader } from "applesauce-loaders/loaders";
import { onlyEvents, RelayPool } from "applesauce-relay";
import { Filter, NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";

import { pubkeyRelays, pubkeyServers } from "./cache.js";
import { LOOKUP_RELAYS } from "./env.js";
import logger from "./logger.js";
import { defaultIfEmpty } from "rxjs";

const log = logger.extend("nostr");

// Create relay pool for connections and subscriptions
const pool = new RelayPool();

// Create event store for caching and deduplicating events
const eventStore = new EventStore();

// Create event loaders
const addressLoader = createAddressLoader(pool, { lookupRelays: LOOKUP_RELAYS, eventStore });
const eventLoader = createEventLoader(pool, { eventStore });

// Attach loaders to event store
eventStore.addressableLoader = addressLoader;
eventStore.replaceableLoader = addressLoader;
eventStore.eventLoader = eventLoader;

/** Fetches a pubkeys mailboxes from the cache or relays */
export async function getUserOutboxes(pubkey: string) {
  const cached = await pubkeyRelays.get(pubkey);
  if (cached) return cached;

  const mailboxes = await lastValueFrom(
    addressLoader({ kind: 10002, pubkey, relays: LOOKUP_RELAYS }).pipe(defaultIfEmpty(undefined)),
  );
  if (!mailboxes) return;

  const outboxes = getOutboxes(mailboxes);
  log(`Found ${outboxes.length} outboxes for ${npubEncode(pubkey)}`);
  await pubkeyRelays.set(pubkey, outboxes);
  return outboxes;
}

/** Fetches a pubkeys blossom servers from the cache or relays */
export async function getUserBlossomServers(pubkey: string, relays: string[]) {
  const cached = await pubkeyServers.get(pubkey);
  if (cached) return cached;

  const blossomServersEvent = await lastValueFrom(
    addressLoader({ kind: BLOSSOM_SERVER_LIST_KIND, pubkey, relays }).pipe(defaultIfEmpty(undefined)),
  );
  if (!blossomServersEvent) return;

  const servers = getBlossomServersFromList(blossomServersEvent).map((s) => s.toString());

  // Save servers if found
  if (servers) {
    log(`Found ${servers.length} blossom servers for ${npubEncode(pubkey)}`);
    await pubkeyServers.set(pubkey, servers);
  }

  return servers;
}

/** Load events from relays */
export function requestEvents(relays: string[], filter: Filter): Promise<NostrEvent[]> {
  return lastValueFrom(
    pool.request(relays, filter).pipe(onlyEvents(), mapEventsToStore(eventStore), mapEventsToTimeline()),
  );
}

export default pool;
