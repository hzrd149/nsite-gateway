import Keyv, { KeyvOptions } from "keyv";
import { CACHE_PATH, CACHE_TIME } from "./env.js";
import logger from "./logger.js";
import { ParsedEvent } from "./events.js";

const log = logger.extend("cache");

async function createStore() {
  if (!CACHE_PATH || CACHE_PATH === "in-memory") return undefined;
  else if (CACHE_PATH.startsWith("redis://")) {
    const { default: KeyvRedis } = await import("@keyv/redis");
    log(`Using redis cache at ${CACHE_PATH}`);
    return new KeyvRedis(CACHE_PATH);
  } else if (CACHE_PATH.startsWith("sqlite://")) {
    const { default: KeyvSqlite } = await import("@keyv/sqlite");
    log(`Using sqlite cache at ${CACHE_PATH}`);
    return new KeyvSqlite(CACHE_PATH);
  }
}

const store = await createStore();

store?.on("error", (err) => {
  log("Connection Error", err);
  process.exit(1);
});

const json: KeyvOptions = { serialize: JSON.stringify, deserialize: JSON.parse };
const opts: KeyvOptions = store ? { store } : {};

/** A cache that maps a domain to a pubkey ( domain -> pubkey ) */
export const pubkeyDomains = new Keyv<string | undefined>({
  ...opts,
  ...json,
  namespace: "domains",
  ttl: CACHE_TIME * 1000,
});

/** A cache that maps a pubkey to a set of blossom servers ( pubkey -> servers ) */
export const pubkeyServers = new Keyv<string[] | undefined>({
  ...opts,
  ...json,
  namespace: "servers",
  ttl: CACHE_TIME * 1000,
});

/** A cache that maps a pubkey to a set of relays ( pubkey -> relays ) */
export const pubkeyRelays = new Keyv<string[] | undefined>({
  ...opts,
  ...json,
  namespace: "relays",
  ttl: CACHE_TIME * 1000,
});

/** A cache that maps a pubkey + path to sha256 hash of the blob ( pubkey/path -> sha256 ) */
export const pathBlobs = new Keyv<ParsedEvent | undefined>({
  ...opts,
  ...json,
  namespace: "paths",
  ttl: CACHE_TIME * 1000,
});

/** A cache that maps a sha256 hash to a set of URLs that had the blob ( sha256 -> URLs ) */
export const blobURLs = new Keyv<string[] | undefined>({
  ...opts,
  ...json,
  namespace: "blobs",
  ttl: CACHE_TIME * 1000,
});

/** A cache that maps a pubkey to all their nsite events ( pubkey -> events[] ) */
export const pubkeyEvents = new Keyv<ParsedEvent[] | undefined>({
  ...opts,
  ...json,
  namespace: "nsite-events",
  ttl: CACHE_TIME * 1000,
});
