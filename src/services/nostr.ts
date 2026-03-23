import { EventStore, lastValueFrom, mapEventsToStore } from "applesauce-core";
import {
  type AddressPointer,
  getOutboxes,
  persistEventsToCache,
} from "applesauce-core/helpers";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { onlyEvents, RelayPool } from "applesauce-relay";
import type { Filter, NostrEvent } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { NSITE_MANIFEST_KIND, NSITE_ROOT_SITE_KIND } from "../helpers/const.ts";
import { CACHE_RELAYS, LOOKUP_RELAYS } from "../helpers/env.ts";
import logger from "../helpers/debug.ts";
import { logDiscoveredManifest } from "../helpers/manifest-log.ts";
import { createPromiseLock } from "../helpers/promise-lock.ts";
import { pubkeyRelays, pubkeyServers, siteManifests } from "./cache.ts";

const log = logger.extend("nostr");
const BLOSSOM_SERVER_LIST_KIND = 10063;

const pool = new RelayPool();
const eventStore = new EventStore();

function getManifestIdentifier(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === "d" && tag[1] !== undefined)?.[1];
}

export function isMatchingManifestAddress(
  event: NostrEvent,
  pubkey: string,
  identifier: string,
): boolean {
  if (event.pubkey !== pubkey) return false;

  if (identifier === "") {
    return event.kind === NSITE_ROOT_SITE_KIND &&
      getManifestIdentifier(event) === undefined;
  }

  return (
    event.kind === NSITE_MANIFEST_KIND &&
    getManifestIdentifier(event) === identifier
  );
}

const cacheRequest = CACHE_RELAYS
  ? (filters: Filter[]) =>
    pool.request(CACHE_RELAYS!, filters).pipe(
      onlyEvents(),
      mapEventsToStore(eventStore),
    )
  : undefined;

const eventLoader = createEventLoaderForStore(eventStore, pool, {
  cacheRequest,
});

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

export const getUserOutboxes = createPromiseLock(
  async (
    pubkey: string,
  ) => {
    const cached = await pubkeyRelays.get(pubkey);
    if (cached) return cached;

    const loadLog = log.extend(npubEncode(pubkey));
    const mailboxes = await lastValueFrom(
      eventLoader({ kind: 10002, pubkey, relays: LOOKUP_RELAYS }),
      { defaultValue: undefined },
    );
    if (!mailboxes) {
      loadLog("No outboxes found");
      return undefined;
    }

    const outboxes = getOutboxes(mailboxes);
    await pubkeyRelays.set(pubkey, outboxes);
    return outboxes;
  },
  (pubkey: string) => pubkey,
);

/** Get the blossom servers for a user from the event store. */
export const getUserBlossomServers = createPromiseLock(
  async (
    pubkey: string,
    relays: string[],
  ) => {
    const cached = await pubkeyServers.get(pubkey);
    if (cached) return cached;

    const loadLog = log.extend(npubEncode(pubkey));
    const event = await lastValueFrom(
      eventLoader({ kind: BLOSSOM_SERVER_LIST_KIND, pubkey, relays }),
      { defaultValue: undefined },
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
  },
  (pubkey: string) => pubkey,
);

export const loadManifest = createPromiseLock(
  async (
    pubkey: string,
    identifier: string,
    relays: string[],
  ) => {
    const key = `${pubkey}:${identifier}`;
    const pointer: AddressPointer = {
      kind: identifier === "" ? NSITE_ROOT_SITE_KIND : NSITE_MANIFEST_KIND,
      pubkey,
      identifier,
      relays,
    };
    const scope = pointer.kind === NSITE_ROOT_SITE_KIND
      ? "root"
      : `named:${identifier}`;
    const loadLog = log.extend(`manifest:${npubEncode(pubkey)}:${scope}`);
    const cached = await siteManifests.get(key);
    if (cached) {
      if (!isMatchingManifestAddress(cached, pubkey, identifier)) {
        loadLog(
          `discarding mismatched cached manifest kind=${cached.kind} id=${cached.id}`,
        );
        siteManifests.delete(key);
      } else {
        loadLog(`cache hit kind=${cached.kind} id=${cached.id}`);
        return cached;
      }
    }

    console.log(
      `[manifest] fetching ${scope} site for ${
        npubEncode(pubkey)
      } kind=${pointer.kind} relays=${
        relays.length > 0 ? relays.join(", ") : "none"
      }`,
    );
    loadLog(
      `fetching manifest kind=${pointer.kind} relays=${
        relays.length > 0 ? relays.join(", ") : "none"
      }`,
    );

    // Manually fetch using request
    const manifest = await lastValueFrom(eventLoader(pointer), {
      defaultValue: undefined,
    });

    if (!manifest) {
      loadLog(
        `manifest miss kind=${pointer.kind} relays=${
          relays.length > 0 ? relays.join(", ") : "none"
        }`,
      );
      return undefined;
    }

    if (!isMatchingManifestAddress(manifest, pubkey, identifier)) {
      const manifestIdentifier = getManifestIdentifier(manifest) ?? "root";
      console.error(
        `[manifest] mismatch requested=${scope} got kind=${manifest.kind} identifier=${manifestIdentifier} id=${manifest.id}`,
      );
      loadLog(
        `manifest mismatch requested=${scope} got kind=${manifest.kind} identifier=${manifestIdentifier} id=${manifest.id}`,
      );
      return undefined;
    }

    loadLog(`manifest hit kind=${manifest.kind} id=${manifest.id}`);
    logDiscoveredManifest(manifest);
    await siteManifests.set(key, manifest);
    return manifest;
  },
  (pubkey: string, identifier: string) => `${pubkey}:${identifier}`,
);

export default pool;
