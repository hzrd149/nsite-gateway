import { dirname } from "@std/path/posix";
import type { AddressPointer } from "applesauce-core/helpers";
import { CACHE_PATH, CACHE_TIME } from "../env.ts";
import logger from "../helpers/debug.ts";
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
    log("Got error while closing cache KV store: ", err);
  }
});

/** Gets the resolved nsite pointer for a domain */
export async function getDNSPubkey(domain: string) {
  const entry = await cache.get<AddressPointer>(["dns", domain]);

  return entry.value;
}

/** Sets the resolved nsite pointer for a domain */
export async function setDNSPubkey(domain: string, pointer: AddressPointer) {
  return await cache.set(["dns", domain], pointer, {
    expireIn: CACHE_TIME * 1000,
  });
}

/** Sets the current blossom used for a blob */
export async function getBlobServer(blob: string) {
  const entry = await cache.get<string>(["blob-server", blob]);

  return entry.value;
}

/** Sets the current blossom used for a blob */
export async function setBlobServer(blob: string, server: string) {
  return await cache.set(["blob-server", blob], server, {
    expireIn: CACHE_TIME * 1000,
  });
}

/** Clears the current blossom used for a blob */
export async function clearBlobServer(blob: string) {
  return await cache.delete(["blob-server", blob]);
}

/** Gets the servers that should be used for streaming a blob */
export async function getBlobServers(blob: string) {
  const entry = await cache.get<string[]>(["blob-servers", blob]);

  return entry.value;
}

/** Sets the servers that should be used for streaming a blob */
export async function setBlobServers(blob: string, servers: string[]) {
  return await cache.set(["blob-servers", blob], servers, {
    expireIn: CACHE_TIME * 1000,
  });
}

/** Clears the cached servers for a blob */
export async function clearBlobServers(blob: string) {
  return await cache.delete(["blob-servers", blob]);
}
