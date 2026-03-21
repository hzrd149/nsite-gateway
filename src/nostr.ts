import {
  EventStore,
  lastValueFrom,
  mapEventsToStore,
  mapEventsToTimeline,
} from "applesauce-core";
import { getOutboxes, persistEventsToCache } from "applesauce-core/helpers";
import {
  createAddressLoader,
  createEventLoader,
} from "applesauce-loaders/loaders";
import { onlyEvents, RelayPool, SyncDirection } from "applesauce-relay";
import type { Filter, NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { debounceTime, defaultIfEmpty, take, takeUntil, timer } from "rxjs";
import {
  pubkeyEvents,
  pubkeyLastSync,
  pubkeyRelays,
  pubkeyServers,
  siteManifests,
} from "./cache.ts";
import {
  NSITE_FILE_KIND,
  NSITE_MANIFEST_KIND,
  NSITE_ROOT_SITE_KIND,
} from "./const.ts";
import { CACHE_RELAYS, LOOKUP_RELAYS } from "./env.ts";
import type { ParsedEvent } from "./events.ts";
import { parseNsiteEvent } from "./events.ts";
import { createPromiseLock } from "./helpers/promise-lock.ts";
import logger from "./logger.ts";

const log = logger.extend("nostr");
const BLOSSOM_SERVER_LIST_KIND = 10063;

const pool = new RelayPool();
const eventStore = new EventStore();

const cacheRequest = CACHE_RELAYS
  ? (filters: Filter[]) =>
    pool.request(CACHE_RELAYS!, filters).pipe(
      onlyEvents(),
      mapEventsToStore(eventStore),
    )
  : undefined;

const addressLoader = createAddressLoader(pool, {
  lookupRelays: LOOKUP_RELAYS,
  eventStore,
  cacheRequest,
});
const eventLoader = createEventLoader(pool, { eventStore, cacheRequest });

(eventStore as any).addressableLoader = addressLoader;
(eventStore as any).replaceableLoader = addressLoader;
(eventStore as any).eventLoader = eventLoader;

if (CACHE_RELAYS) {
  log(`Using cache relays: ${CACHE_RELAYS.join(", ")}`);
  persistEventsToCache(eventStore, async (events: NostrEvent[]) => {
    await Promise.allSettled(
      events.map((event) => pool.publish(CACHE_RELAYS!, event)),
    );
  });
}

function getBlossomServersFromList(event: NostrEvent): URL[] {
  return event.tags
    .filter((tag) => tag[0] === "r" && tag[1])
    .map((tag) => {
      try {
        return new URL(tag[1]);
      } catch {
        return null;
      }
    })
    .filter((url): url is URL => Boolean(url));
}

async function getUserOutboxesInternal(
  pubkey: string,
): Promise<string[] | undefined> {
  const cached = await pubkeyRelays.get(pubkey);
  if (cached) return cached;

  const loadLog = log.extend(npubEncode(pubkey));
  const mailboxes = await lastValueFrom(
    addressLoader({ kind: 10002, pubkey, relays: LOOKUP_RELAYS }).pipe(
      defaultIfEmpty(undefined),
    ),
  );
  if (!mailboxes) {
    loadLog("No outboxes found");
    return undefined;
  }

  const outboxes = getOutboxes(mailboxes);
  await pubkeyRelays.set(pubkey, outboxes);
  return outboxes;
}

export const getUserOutboxes = createPromiseLock(
  getUserOutboxesInternal,
  (pubkey: string) => pubkey,
);

async function getUserBlossomServersInternal(
  pubkey: string,
  relays: string[],
): Promise<string[] | undefined> {
  const cached = await pubkeyServers.get(pubkey);
  if (cached) return cached;

  const loadLog = log.extend(npubEncode(pubkey));
  const event = await lastValueFrom(
    addressLoader({ kind: BLOSSOM_SERVER_LIST_KIND, pubkey, relays }).pipe(
      defaultIfEmpty(undefined),
    ),
  );
  if (!event) {
    loadLog("No blossom servers event found");
    return undefined;
  }

  const servers = getBlossomServersFromList(event).map((server: URL) =>
    server.toString()
  );
  await pubkeyServers.set(pubkey, servers);
  return servers;
}

export const getUserBlossomServers = createPromiseLock(
  getUserBlossomServersInternal,
  (pubkey: string) => pubkey,
);

const ONE_DAY = 86400 * 1000;

async function loadEventsInternal(
  pubkey: string,
  relays: string[],
): Promise<ParsedEvent[]> {
  const loadLog = log.extend(npubEncode(pubkey));
  const lastSyncTime = await pubkeyLastSync.get(pubkey);
  const cachedEvents = await pubkeyEvents.get(pubkey);

  if (
    cachedEvents && lastSyncTime !== undefined &&
    lastSyncTime > Math.floor((Date.now() - ONE_DAY) / 1000)
  ) {
    return cachedEvents.map(parseNsiteEvent).filter((
      event,
    ): event is ParsedEvent => Boolean(event));
  }

  if (cachedEvents) {
    for (const event of cachedEvents) eventStore.add(event);
  }

  const supported = await Promise.all(
    relays.map(async (url) => {
      const relay = pool.relay(url);
      return [relay, await relay.getSupported()] as const;
    }),
  );
  const syncRelayUrls = supported.filter(([, caps]) => caps?.includes(77)).map((
    [relay],
  ) => relay.url);
  const requestRelayUrls = supported.filter(([, caps]) => !caps?.includes(77))
    .map(([relay]) => relay.url);

  const filter: Filter = {
    kinds: [NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND, NSITE_FILE_KIND],
    authors: [pubkey],
  };
  if (lastSyncTime !== undefined) filter.since = lastSyncTime;

  const requests: Promise<NostrEvent[]>[] = [];

  if (syncRelayUrls.length > 0) {
    requests.push(
      lastValueFrom(
        pool
          .sync(syncRelayUrls, eventStore, filter, SyncDirection.RECEIVE)
          .pipe(
            mapEventsToStore(eventStore),
            mapEventsToTimeline(),
            debounceTime(500),
            take(1),
            takeUntil(timer(5000)),
          ),
      ).catch(() => []),
    );
  }

  if (requestRelayUrls.length > 0) {
    requests.push(
      lastValueFrom(
        pool
          .request(requestRelayUrls, filter)
          .pipe(
            mapEventsToStore(eventStore),
            mapEventsToTimeline(),
            takeUntil(timer(5000)),
          ),
      ).catch(() => []),
    );
  }

  await Promise.allSettled(requests);

  const allEvents = eventStore.getByFilters({
    kinds: [NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND, NSITE_FILE_KIND],
    authors: [pubkey],
  });

  await pubkeyLastSync.set(pubkey, Math.floor(Date.now() / 1000));
  await pubkeyEvents.set(pubkey, allEvents);

  const parsedEvents = allEvents.map(parseNsiteEvent).filter((
    event,
  ): event is ParsedEvent => Boolean(event));
  const eventsByPath = new Map<string, ParsedEvent>();
  for (const event of parsedEvents) {
    const existing = eventsByPath.get(event.path);
    if (!existing || event.created_at > existing.created_at) {
      eventsByPath.set(event.path, event);
    }
  }

  loadLog(`Returning ${eventsByPath.size} parsed nsite events`);
  return Array.from(eventsByPath.values());
}

export const loadEvents = createPromiseLock(
  loadEventsInternal,
  (pubkey: string) => pubkey,
);

export function requestEvents(
  relays: string[],
  filter: Filter,
): Promise<NostrEvent[]> {
  return lastValueFrom(
    pool.request(relays, filter).pipe(
      onlyEvents(),
      mapEventsToStore(eventStore),
      mapEventsToTimeline(),
    ),
  );
}

async function loadManifestInternal(
  pubkey: string,
  identifier: string,
  relays: string[],
): Promise<NostrEvent | undefined> {
  const key = `${pubkey}:${identifier}`;
  const cached = await siteManifests.get(key);
  if (cached) return cached;

  const manifest = await lastValueFrom(
    addressLoader({
      kind: identifier === "" ? NSITE_ROOT_SITE_KIND : NSITE_MANIFEST_KIND,
      pubkey,
      ...(identifier !== "" ? { d: identifier } : {}),
      relays,
    }).pipe(defaultIfEmpty(undefined)),
  );

  if (!manifest) return undefined;
  await siteManifests.set(key, manifest);
  return manifest;
}

export const loadManifest = createPromiseLock(
  loadManifestInternal,
  (pubkey: string, identifier: string) => `${pubkey}:${identifier}`,
);

export default pool;
