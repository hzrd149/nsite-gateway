import type { NostrEvent } from "nostr-tools";
import {
  CACHE_BACKEND,
  CACHE_MAX_ENTRIES,
  CACHE_TIME,
  KV_PATH,
} from "./env.ts";
import type { ParsedEvent } from "./events.ts";
import logger from "./logger.ts";

type CachedPathBlob = ParsedEvent & {
  servers?: string[];
  source?: "manifest";
  manifestId?: string;
};

type CacheStore<T> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): void;
};

const log = logger.extend("cache");

class MemoryCache<T> implements CacheStore<T> {
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

  async get(key: string): Promise<T | undefined> {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: T): Promise<void> {
    this.#sweepExpired();
    if (this.#store.has(key)) this.#store.delete(key);
    this.#store.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
    this.#evictOldest();
  }

  delete(key: string): void {
    this.#store.delete(key);
  }
}

let kvPromise: Promise<Deno.Kv | undefined> | undefined;

async function getKv(): Promise<Deno.Kv | undefined> {
  if (CACHE_BACKEND !== "kv") return undefined;
  if (!kvPromise) {
    kvPromise = Deno.openKv(KV_PATH).then((kv) => {
      log(
        KV_PATH
          ? `Using Deno KV cache at ${KV_PATH}`
          : "Using default Deno KV cache location",
      );
      return kv;
    });
  }
  return await kvPromise;
}

class KvCache<T> implements CacheStore<T> {
  #namespace: string;
  #ttlMs: number;

  constructor(namespace: string, ttlMs: number) {
    this.#namespace = namespace;
    this.#ttlMs = ttlMs;
  }

  #key(key: string): Deno.KvKey {
    return ["cache", this.#namespace, key];
  }

  async get(key: string): Promise<T | undefined> {
    const kv = await getKv();
    if (!kv) return undefined;
    const entry = await kv.get<T>(this.#key(key));
    return entry.value ?? undefined;
  }

  async set(key: string, value: T): Promise<void> {
    const kv = await getKv();
    if (!kv) return;
    await kv.set(this.#key(key), value, { expireIn: this.#ttlMs });
  }

  delete(key: string): void {
    void getKv().then((kv) => {
      if (!kv) return;
      return kv.delete(this.#key(key));
    }).catch((error) => {
      log(
        `Failed to delete cache key ${this.#namespace}:${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}

class Cache<T> {
  #memory: MemoryCache<T>;
  #kv: KvCache<T>;

  constructor(namespace: string, ttlMs: number, maxEntries: number) {
    this.#memory = new MemoryCache<T>(ttlMs, maxEntries);
    this.#kv = new KvCache<T>(namespace, ttlMs);
  }

  async get(key: string): Promise<T | undefined> {
    if (CACHE_BACKEND === "kv") return await this.#kv.get(key);
    return await this.#memory.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    if (CACHE_BACKEND === "kv") return await this.#kv.set(key, value);
    return await this.#memory.set(key, value);
  }

  delete(key: string): void {
    if (CACHE_BACKEND === "kv") return this.#kv.delete(key);
    return this.#memory.delete(key);
  }
}

export async function closeCache(): Promise<void> {
  const kv = await kvPromise;
  kv?.close();
}

export async function initCache(): Promise<void> {
  await getKv();
}

const ttlMs = CACHE_TIME * 1000;

if (CACHE_BACKEND === "in-memory") {
  log(`Using in-memory cache (${CACHE_MAX_ENTRIES} max entries)`);
}

export const pubkeyDomains = new Cache<
  { pubkey: string; identifier: string } | undefined
>("domains", ttlMs, CACHE_MAX_ENTRIES);
export const pubkeyServers = new Cache<string[] | undefined>(
  "servers",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const pubkeyRelays = new Cache<string[] | undefined>(
  "relays",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const pathBlobs = new Cache<CachedPathBlob | undefined>(
  "paths",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const manifestPaths = new Cache<string[] | undefined>(
  "manifest-paths",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const siteManifests = new Cache<NostrEvent | undefined>(
  "manifests",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const blobURLs = new Cache<string[] | undefined>(
  "blobs",
  ttlMs,
  CACHE_MAX_ENTRIES,
);
