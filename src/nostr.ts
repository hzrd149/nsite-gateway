import { EventStore, lastValueFrom, mapEventsToStore, mapEventsToTimeline } from "applesauce-core";
import {
  BLOSSOM_SERVER_LIST_KIND,
  getBlossomServersFromList,
  getOutboxes,
  persistEventsToCache,
} from "applesauce-core/helpers";
import { createAddressLoader, createEventLoader } from "applesauce-loaders/loaders";
import { onlyEvents, RelayPool, SyncDirection } from "applesauce-relay";
import { Filter, NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { debounceTime, defaultIfEmpty, take, takeUntil, takeWhile, tap, timeout, timer, toArray } from "rxjs";

import { pubkeyEvents, pubkeyRelays, pubkeyServers } from "./cache.js";
import { NSITE_KIND } from "./const.js";
import { CACHE_RELAYS, LOOKUP_RELAYS } from "./env.js";
import { ParsedEvent, parseNsiteEvent } from "./events.js";
import { createPromiseLock } from "./helpers/promise-lock.js";
import logger from "./logger.js";

const log = logger.extend("nostr");

// Create relay pool for connections and subscriptions
const pool = new RelayPool();

// Create event store for caching and deduplicating events
const eventStore = new EventStore();

// Load events from cache relays if defined
const cacheRequest =
  CACHE_RELAYS &&
  ((filters: Filter[]) => {
    return pool.request(CACHE_RELAYS!, filters).pipe(onlyEvents(), mapEventsToStore(eventStore));
  });

// Create event loaders
const addressLoader = createAddressLoader(pool, { lookupRelays: LOOKUP_RELAYS, eventStore, cacheRequest });
const eventLoader = createEventLoader(pool, { eventStore, cacheRequest });

// Attach loaders to event store
eventStore.addressableLoader = addressLoader;
eventStore.replaceableLoader = addressLoader;
eventStore.eventLoader = eventLoader;

// Send all new events to the cache relays
if (CACHE_RELAYS) {
  log(`Persisting events to cache relays: ${CACHE_RELAYS.join(", ")}`);

  persistEventsToCache(eventStore, async (events) => {
    await Promise.allSettled(events.map((event) => pool.publish(CACHE_RELAYS!, event)));
  });
}

/** Internal function that fetches a pubkeys mailboxes from the cache or relays */
async function getUserOutboxesInternal(pubkey: string): Promise<string[] | undefined> {
  const cached = await pubkeyRelays.get(pubkey);
  if (cached) return cached;

  const loadLog = log.extend(npubEncode(pubkey));

  const mailboxes = await lastValueFrom(
    addressLoader({ kind: 10002, pubkey, relays: LOOKUP_RELAYS }).pipe(defaultIfEmpty(undefined)),
  );
  if (!mailboxes) {
    loadLog("No outboxes found");
    return;
  }

  const outboxes = getOutboxes(mailboxes);
  loadLog(`Found ${outboxes.length} outboxes`);
  await pubkeyRelays.set(pubkey, outboxes);
  return outboxes;
}

/** Fetches a pubkeys mailboxes from the cache or relays (with promise locking) */
export const getUserOutboxes = createPromiseLock(getUserOutboxesInternal, (pubkey: string) => pubkey);

/** Internal function that fetches a pubkeys blossom servers from the cache or relays */
async function getUserBlossomServersInternal(pubkey: string, relays: string[]): Promise<string[] | undefined> {
  const cached = await pubkeyServers.get(pubkey);
  if (cached) return cached;

  const loadLog = log.extend(npubEncode(pubkey));

  const blossomServersEvent = await lastValueFrom(
    addressLoader({ kind: BLOSSOM_SERVER_LIST_KIND, pubkey, relays }).pipe(defaultIfEmpty(undefined)),
  );
  if (!blossomServersEvent) {
    loadLog("No blossom servers event found");
    return;
  }

  const servers = getBlossomServersFromList(blossomServersEvent).map((s) => s.toString());

  // Save servers if found
  if (servers) {
    loadLog(`Found ${servers.length} servers`);
    await pubkeyServers.set(pubkey, servers);
  }

  return servers;
}

/** Fetches a pubkeys blossom servers from the cache or relays (with promise locking) */
export const getUserBlossomServers = createPromiseLock(
  getUserBlossomServersInternal,
  (pubkey: string) => pubkey, // Lock by pubkey only
);

/** Internal function that does the actual event loading */
async function loadEventsInternal(pubkey: string, relays: string[]): Promise<ParsedEvent[]> {
  // Check cache first
  const cached = await pubkeyEvents.get(pubkey);
  if (cached) return cached;

  const loadLog = log.extend(npubEncode(pubkey));
  // Check which relays support NIP-77
  const supported = await Promise.all(
    relays.map(async (url) => {
      const relay = pool.relay(url);
      return [relay, await relay.getSupported()] as const;
    }),
  );
  const syncRelayUrls = supported.filter(([_, supported]) => supported?.includes(77)).map(([relay]) => relay.url);
  const requestRelayUrls = supported.filter(([_, supported]) => !supported?.includes(77)).map(([relay]) => relay.url);

  loadLog(`Found ${syncRelayUrls.length} NIP-77 relays and ${requestRelayUrls.length} non-NIP-77 relays`);

  const filter: Filter = { kinds: [NSITE_KIND], authors: [pubkey] };
  const requests: Promise<NostrEvent[]>[] = [];

  // Use pool.sync for NIP-77 relays
  if (syncRelayUrls.length > 0) {
    const p = lastValueFrom(
      pool.sync(syncRelayUrls, eventStore, filter, SyncDirection.RECEIVE).pipe(
        mapEventsToStore(eventStore),
        mapEventsToTimeline(),
        // Close sync after .5s of no new events. this is a fix for a bug in applesauce-relay
        debounceTime(500),
        take(1),
        // Max request time of 5s
        takeUntil(timer(5000)),
      ),
    ).then(
      (events) => {
        loadLog(`Fetched ${events.length} events via NIP-77 sync`);
        return events;
      },
      (error) => {
        loadLog(`Error syncing with NIP-77: ${error}`);
        return [];
      },
    );

    requests.push(p);
  }

  // Use pool.request for non-NIP-77 relays
  if (requestRelayUrls.length > 0) {
    const p = lastValueFrom(
      pool.request(requestRelayUrls, filter).pipe(
        mapEventsToStore(eventStore),
        mapEventsToTimeline(),
        // Max request time of 5s
        takeUntil(timer(5000)),
      ),
    ).then(
      (events) => {
        loadLog(`Fetched ${events.length} events via regular request`);
        return events;
      },
      (error) => {
        loadLog(`Error requesting events: ${error}`);
        return [];
      },
    );

    requests.push(p);
  }

  // Wait for both requests to complete
  await Promise.allSettled(requests);

  // Pass all events through the event store to deduplicate
  const events = eventStore.getByFilters(filter);

  // Parse events
  const parsedEvents = events.map(parseNsiteEvent).filter((e): e is ParsedEvent => !!e);

  // Deduplicate by path, keeping the most recent
  const eventsByPath = new Map<string, ParsedEvent>();
  for (const event of parsedEvents) {
    const existing = eventsByPath.get(event.path);
    if (!existing || event.created_at > existing.created_at) {
      eventsByPath.set(event.path, event);
    }
  }

  const finalEvents = Array.from(eventsByPath.values());
  loadLog(`Found ${finalEvents.length} nsite events`);

  // Cache the results
  await pubkeyEvents.set(pubkey, finalEvents);

  return finalEvents;
}

/** Load all nsite events for a pubkey (with promise locking to prevent duplicate concurrent requests) */
export const loadEvents = createPromiseLock(
  loadEventsInternal,
  (pubkey: string) => pubkey, // Use pubkey as the lock key
);

/** Load events from relays */
export function requestEvents(relays: string[], filter: Filter): Promise<NostrEvent[]> {
  return lastValueFrom(
    pool.request(relays, filter).pipe(onlyEvents(), mapEventsToStore(eventStore), mapEventsToTimeline()),
  );
}

export default pool;
