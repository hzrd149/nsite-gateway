import { join } from "@std/path";
import type { NostrEvent } from "nostr-tools";
import type { ParsedEvent } from "../helpers/events.ts";
import logger from "../helpers/debug.ts";
import {
  CACHE_BACKEND,
  CACHE_MAX_ENTRIES,
  CACHE_TIME,
  KV_PATH,
} from "../helpers/env.ts";

const log = logger.extend("cache");

type CachedPathBlob = ParsedEvent & {
  servers?: string[];
  source?: "manifest";
  manifestId?: string;
};

export type CacheEntry<T> = {
  key: string;
  value: T;
};

type GatewayCache<T> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): void;
  list(): Promise<CacheEntry<T>[]>;
  init(): Promise<void>;
  close(): Promise<void>;
};

class MemoryCache<T> implements GatewayCache<T> {
  #ttlMs: number;
  #maxEntries: number;
  #store = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs: number, maxEntries: number) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  #sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (entry.expiresAt <= now) this.#store.delete(key);
    }
  }

  #evictOldest() {
    while (this.#store.size > this.#maxEntries) {
      const oldestKey = this.#store.keys().next().value;
      if (!oldestKey) break;
      this.#store.delete(oldestKey);
    }
  }

  get(key: string): Promise<T | undefined> {
    const entry = this.#store.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: T): Promise<void> {
    this.#sweepExpired();
    if (this.#store.has(key)) this.#store.delete(key);
    this.#store.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
    this.#evictOldest();
    return Promise.resolve();
  }

  delete(key: string): void {
    this.#store.delete(key);
  }

  list(): Promise<CacheEntry<T>[]> {
    this.#sweepExpired();
    return Promise.resolve([...this.#store.entries()].map(([key, entry]) => ({
      key,
      value: entry.value,
    })));
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const KV_FILE_EXTENSION = ".kv";

function getKvStorePath(namespace: string): string | undefined {
  if (!KV_PATH) return undefined;
  return join(KV_PATH, `${namespace}${KV_FILE_EXTENSION}`);
}

class KvCache<T> implements GatewayCache<T> {
  #namespace: string;
  #ttlMs: number;
  #kvPromise: Promise<Deno.Kv> | undefined;

  constructor(namespace: string, ttlMs: number) {
    this.#namespace = namespace;
    this.#ttlMs = ttlMs;
  }

  async #getKv(): Promise<Deno.Kv> {
    if (!this.#kvPromise) {
      this.#kvPromise = (async () => {
        const path = getKvStorePath(this.#namespace);
        if (KV_PATH) {
          await Deno.mkdir(KV_PATH, { recursive: true });
          log(`Using Deno KV cache ${this.#namespace} at ${path}`);
        } else {
          log(
            `Using default Deno KV cache location for ${this.#namespace}`,
          );
        }
        return await Deno.openKv(path);
      })();
    }
    return await this.#kvPromise;
  }

  async get(key: string): Promise<T | undefined> {
    const kv = await this.#getKv();
    const entry = await kv.get<T>([key]);
    return entry.value ?? undefined;
  }

  async set(key: string, value: T): Promise<void> {
    const kv = await this.#getKv();
    await kv.set([key], value, { expireIn: this.#ttlMs });
  }

  delete(key: string): void {
    void this.#getKv().then((kv) => kv.delete([key])).catch((error) => {
      log(
        `Failed to delete cache key ${this.#namespace}:${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async list(): Promise<CacheEntry<T>[]> {
    const kv = await this.#getKv();
    const entries: CacheEntry<T>[] = [];

    for await (const entry of kv.list<T>({ prefix: [] })) {
      const key = entry.key[0];
      if (typeof key !== "string" || entry.value === null) continue;
      entries.push({ key, value: entry.value });
    }

    return entries;
  }

  async init(): Promise<void> {
    await this.#getKv();
  }

  async close(): Promise<void> {
    const kv = await this.#kvPromise;
    kv?.close();
    this.#kvPromise = undefined;
  }
}

export async function closeCache(): Promise<void> {
  await Promise.all([
    pubkeyDomains.close(),
    pubkeyServers.close(),
    pubkeyRelays.close(),
    pathBlobs.close(),
    manifestPaths.close(),
    siteManifests.close(),
    blobURLs.close(),
  ]);
}

export async function initCache(): Promise<void> {
  await Promise.all([
    pubkeyDomains.init(),
    pubkeyServers.init(),
    pubkeyRelays.init(),
    pathBlobs.init(),
    manifestPaths.init(),
    siteManifests.init(),
    blobURLs.init(),
  ]);
}

const ttlMs = CACHE_TIME * 1000;

if (CACHE_BACKEND === "in-memory") {
  log(`Using in-memory cache (${CACHE_MAX_ENTRIES} max entries)`);
}

export const pubkeyDomains: GatewayCache<
  { pubkey: string; identifier: string } | undefined
> = CACHE_BACKEND === "kv"
  ? new KvCache("domains", ttlMs)
  : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const pubkeyServers: GatewayCache<string[] | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("servers", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const pubkeyRelays: GatewayCache<string[] | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("relays", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const pathBlobs: GatewayCache<CachedPathBlob | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("paths", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const manifestPaths: GatewayCache<string[] | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("manifest-paths", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const siteManifests: GatewayCache<NostrEvent | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("manifests", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
export const blobURLs: GatewayCache<string[] | undefined> =
  CACHE_BACKEND === "kv"
    ? new KvCache("blobs", ttlMs)
    : new MemoryCache(ttlMs, CACHE_MAX_ENTRIES);
