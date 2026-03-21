import type { NostrEvent } from "nostr-tools";
import { CACHE_TIME } from "./env.ts";
import type { ParsedEvent } from "./events.ts";

class TTLCache<T> {
  #ttlMs: number;
  #store = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
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
    this.#store.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  delete(key: string): void {
    this.#store.delete(key);
  }
}

const ttlMs = CACHE_TIME * 1000;

export const pubkeyDomains = new TTLCache<string | undefined>(ttlMs);
export const pubkeyServers = new TTLCache<string[] | undefined>(ttlMs);
export const pubkeyRelays = new TTLCache<string[] | undefined>(ttlMs);
export const pathBlobs = new TTLCache<ParsedEvent | undefined>(ttlMs);
export const siteManifests = new TTLCache<NostrEvent | undefined>(ttlMs);
export const blobURLs = new TTLCache<string[] | undefined>(ttlMs);
export const pubkeyEvents = new TTLCache<NostrEvent[] | undefined>(ttlMs);
export const pubkeyLastSync = new TTLCache<number | undefined>(ttlMs);
