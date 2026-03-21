import type { NostrEvent } from "nostr-tools";
import { CACHE_MAX_ENTRIES, CACHE_TIME } from "./env.ts";
import type { ParsedEvent } from "./events.ts";

class TTLCache<T> {
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

const ttlMs = CACHE_TIME * 1000;

export const pubkeyDomains = new TTLCache<
  { pubkey: string; identifier: string } | undefined
>(ttlMs, CACHE_MAX_ENTRIES);
export const pubkeyServers = new TTLCache<string[] | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const pubkeyRelays = new TTLCache<string[] | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const pathBlobs = new TTLCache<ParsedEvent | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const siteManifests = new TTLCache<NostrEvent | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const blobURLs = new TTLCache<string[] | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
export const pubkeyEvents = new TTLCache<NostrEvent[] | undefined>(
  ttlMs,
  Math.max(512, Math.floor(CACHE_MAX_ENTRIES / 4)),
);
export const pubkeyLastSync = new TTLCache<number | undefined>(
  ttlMs,
  CACHE_MAX_ENTRIES,
);
