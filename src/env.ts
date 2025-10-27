import "dotenv/config";
import xbytes from "xbytes";

const NSITE_HOMEPAGE =
  process.env.NSITE_HOMEPAGE ||
  "nprofile1qqspspfsrjnurtf0jdyswm8jstustv7pu4qw3pn4u99etptvgzm4uvcpz9mhxue69uhkummnw3e82efwvdhk6qg5waehxw309aex2mrp0yhxgctdw4eju6t04mzfem";
const NSITE_HOMEPAGE_DIR = process.env.NSITE_HOMEPAGE_DIR || "public";

// Relays to lookup users outboxes and blossom servers
const LOOKUP_RELAYS = process.env.LOOKUP_RELAYS?.split(",").map((u) => u.trim()) ?? [
  "wss://user.kindpag.es/",
  "wss://purplepag.es/",
];

// Relays to cache events and blobs on
const CACHE_RELAYS = process.env.CACHE_RELAYS?.split(",").map((u) => u.trim());

// Relays to subscribe to for new nsite events
const SUBSCRIPTION_RELAYS = process.env.SUBSCRIPTION_RELAYS?.split(",").map((u) => u.trim()) ?? [
  "wss://nos.lol",
  "wss://relay.damus.io",
];

// Extra blossom servers to use
const BLOSSOM_SERVERS = process.env.BLOSSOM_SERVERS?.split(",").map((u) => u.trim()) ?? [];

// Maximum file size to serve
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE ? xbytes.parseSize(process.env.MAX_FILE_SIZE) : Infinity;

// Where to cache nostr events
const CACHE_PATH = process.env.CACHE_PATH;
// How long to cache nostr events
const CACHE_TIME = process.env.CACHE_TIME ? parseInt(process.env.CACHE_TIME) : 60 * 60;

/** Optional NIP-05 domains to use to resolve names */
const NIP05_NAME_DOMAINS = process.env.NIP05_NAME_DOMAINS?.split(",").map((d) => d.trim());

const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN;

const PAC_PROXY = process.env.PAC_PROXY;
const TOR_PROXY = process.env.TOR_PROXY;
const I2P_PROXY = process.env.I2P_PROXY;

/** Server hostname */
const NSITE_HOST = process.env.NSITE_HOST || "0.0.0.0";
/** Server port */
const NSITE_PORT = process.env.NSITE_PORT ? parseInt(process.env.NSITE_PORT) : 3000;

/** Hostname and port */
const HOST = `${NSITE_HOST}:${NSITE_PORT}`;

/** The tor onion address */
const ONION_HOST = process.env.ONION_HOST;

export {
  NSITE_HOMEPAGE,
  NSITE_HOMEPAGE_DIR,
  LOOKUP_RELAYS,
  CACHE_RELAYS,
  SUBSCRIPTION_RELAYS,
  BLOSSOM_SERVERS,
  MAX_FILE_SIZE,
  CACHE_PATH,
  PAC_PROXY,
  TOR_PROXY,
  I2P_PROXY,
  NSITE_HOST,
  NSITE_PORT,
  HOST,
  ONION_HOST,
  CACHE_TIME,
  NIP05_NAME_DOMAINS,
  PUBLIC_DOMAIN,
};
