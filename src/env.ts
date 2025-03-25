import "dotenv/config";
import xbytes from "xbytes";

const NSITE_HOMEPAGE = process.env.NSITE_HOMEPAGE;
const NSITE_HOMEPAGE_DIR = process.env.NSITE_HOMEPAGE_DIR || "public";

const LOOKUP_RELAYS = process.env.LOOKUP_RELAYS?.split(",").map((u) => u.trim()) ?? [
  "wss://user.kindpag.es/",
  "wss://purplepag.es/",
];
const SUBSCRIPTION_RELAYS = process.env.SUBSCRIPTION_RELAYS?.split(",").map((u) => u.trim()) ?? [
  "wss://nos.lol",
  "wss://relay.damus.io",
];
const BLOSSOM_SERVERS = process.env.BLOSSOM_SERVERS?.split(",").map((u) => u.trim()) ?? [];

const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE ? xbytes.parseSize(process.env.MAX_FILE_SIZE) : Infinity;

const NGINX_CACHE_DIR = process.env.NGINX_CACHE_DIR;
const CACHE_PATH = process.env.CACHE_PATH;
const CACHE_TIME = process.env.CACHE_TIME ? parseInt(process.env.CACHE_TIME) : 60 * 60;

const PAC_PROXY = process.env.PAC_PROXY;
const TOR_PROXY = process.env.TOR_PROXY;
const I2P_PROXY = process.env.I2P_PROXY;

const NSITE_HOST = process.env.NSITE_HOST || "0.0.0.0";
const NSITE_PORT = process.env.NSITE_PORT ? parseInt(process.env.NSITE_PORT) : 3000;
const HOST = `${NSITE_HOST}:${NSITE_PORT}`;

const ENABLE_SCREENSHOTS = process.env.ENABLE_SCREENSHOTS === "true";
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || "./screenshots";

const ONION_HOST = process.env.ONION_HOST;

export {
  NSITE_HOMEPAGE,
  NSITE_HOMEPAGE_DIR,
  SUBSCRIPTION_RELAYS,
  LOOKUP_RELAYS,
  BLOSSOM_SERVERS,
  MAX_FILE_SIZE,
  NGINX_CACHE_DIR,
  CACHE_PATH,
  PAC_PROXY,
  TOR_PROXY,
  I2P_PROXY,
  NSITE_HOST,
  NSITE_PORT,
  HOST,
  ENABLE_SCREENSHOTS,
  SCREENSHOTS_DIR,
  ONION_HOST,
  CACHE_TIME,
};
