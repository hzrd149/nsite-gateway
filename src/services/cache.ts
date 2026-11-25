import { dirname } from "@std/path/posix";
import {
  BLOB_BAD_SOURCE_TTL,
  BLOB_SERVER_TTL,
  CACHE_PATH,
  CACHE_TIME,
} from "../env.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import logger from "../helpers/debug.ts";
import { logValue } from "../helpers/request-log.ts";
import { onShutdown } from "../helpers/shutdown.ts";

const log = logger.extend("cache");

// Ensure the cache directory exists
log(`Opening cache KV store at ${CACHE_PATH}`);
if (CACHE_PATH) await Deno.mkdir(dirname(CACHE_PATH), { recursive: true });

/** Singleton KV store for all cache items */
export const cache = await Deno.openKv(CACHE_PATH);

// Close the cache on shutdown
onShutdown(async () => {
  log("Closing cache KV store");

  try {
    await cache.close();
  } catch (err) {
    log("Got error while closing cache KV store: %s", logValue(err));
  }
}, "storage");

/** Gets the resolved nsite pointer for a domain */
export async function getDNSPubkey(domain: string) {
  const entry = await cache.get<ResolvedSiteAddress>(["dns", domain]);

  return entry.value;
}

/** Sets the resolved nsite pointer for a domain */
export async function setDNSPubkey(
  domain: string,
  pointer: ResolvedSiteAddress,
) {
  return await cache.set(["dns", domain], pointer, {
    expireIn: CACHE_TIME * 1000,
  });
}

// Source selection is publisher-scoped, including proxy discovery hints.
// Deliberately do not read legacy hash-only keys: they may be poisoned.
/** Gets the current blossom used for a publisher's blob */
export async function getBlobServer(pubkey: string, blob: string) {
  const entry = await cache.get<string>(["blob-server", pubkey, blob]);

  return entry.value;
}

/** Sets the current blossom used for a blob */
export async function setBlobServer(
  pubkey: string,
  blob: string,
  server: string,
) {
  return await cache.set(["blob-server", pubkey, blob], server, {
    expireIn: BLOB_SERVER_TTL * 1000,
  });
}

/** Clears the current blossom used for a blob */
export async function clearBlobServer(pubkey: string, blob: string) {
  return await cache.delete(["blob-server", pubkey, blob]);
}

/** Gets the servers that should be used for streaming a blob */
export async function getBlobServers(pubkey: string, blob: string) {
  const entry = await cache.get<string[]>(["blob-servers", pubkey, blob]);

  return entry.value;
}

/** Sets the servers that should be used for streaming a blob */
export async function setBlobServers(
  pubkey: string,
  blob: string,
  servers: string[],
) {
  return await cache.set(["blob-servers", pubkey, blob], servers, {
    expireIn: CACHE_TIME * 1000,
  });
}

/** Clears the cached servers for a blob */
export async function clearBlobServers(pubkey: string, blob: string) {
  return await cache.delete(["blob-servers", pubkey, blob]);
}

export type BadBlobSourceEntry = {
  reason: string;
  createdAt: number;
  expiresAt: number;
};

/** Gets a cached bad source for a blob */
export async function getBadBlobSource(
  pubkey: string,
  blob: string,
  server: string,
) {
  const entry = await cache.get<BadBlobSourceEntry>([
    "blob-source-bad",
    pubkey,
    blob,
    server,
  ]);

  return entry.value;
}

/** Marks a source as bad for a blob for a limited time */
export async function setBadBlobSource(
  pubkey: string,
  blob: string,
  server: string,
  reason: string,
) {
  const now = Date.now();
  return await cache.set(
    ["blob-source-bad", pubkey, blob, server],
    {
      reason,
      createdAt: now,
      expiresAt: now + BLOB_BAD_SOURCE_TTL * 1000,
    } satisfies BadBlobSourceEntry,
    {
      expireIn: BLOB_BAD_SOURCE_TTL * 1000,
    },
  );
}

/** Clears a bad source entry for a blob */
export async function clearBadBlobSource(
  pubkey: string,
  blob: string,
  server: string,
) {
  return await cache.delete(["blob-source-bad", pubkey, blob, server]);
}
