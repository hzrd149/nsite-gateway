import xbytes from "xbytes";

function getList(name: string, fallback: string[] = []): string[] {
  const value = Deno.env.get(name);
  if (!value) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function checkLocalHttp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const NSITE_HOMEPAGE = Deno.env.get("NSITE_HOMEPAGE") ||
  "nprofile1qqspspfsrjnurtf0jdyswm8jstustv7pu4qw3pn4u99etptvgzm4uvcpz9mhxue69uhkummnw3e82efwvdhk6qg5waehxw309aex2mrp0yhxgctdw4eju6t04mzfem";
const NSITE_HOMEPAGE_DIR = Deno.env.get("NSITE_HOMEPAGE_DIR") || "public";

const LOOKUP_RELAYS = getList("LOOKUP_RELAYS", [
  "wss://user.kindpag.es/",
  "wss://purplepag.es/",
]);

const LOCAL_CACHE_RELAY = "ws://localhost:4869";
const CACHE_RELAYS = Deno.env.get("CACHE_RELAYS")
  ? getList("CACHE_RELAYS")
  : (await checkLocalHttp("http://localhost:4869"))
  ? [LOCAL_CACHE_RELAY]
  : undefined;

const SUBSCRIPTION_RELAYS = getList("SUBSCRIPTION_RELAYS", [
  "wss://nos.lol",
  "wss://relay.damus.io",
]);

const BLOSSOM_SERVERS = getList("BLOSSOM_SERVERS");

const LOCAL_BLOSSOM_PROXY = "http://localhost:24242";
const BLOSSOM_PROXY = Deno.env.get("BLOSSOM_PROXY")?.trim() ||
  ((await checkLocalHttp(LOCAL_BLOSSOM_PROXY))
    ? LOCAL_BLOSSOM_PROXY
    : undefined);

const MAX_FILE_SIZE = Deno.env.get("MAX_FILE_SIZE")
  ? xbytes.parseSize(Deno.env.get("MAX_FILE_SIZE")!)
  : Infinity;

const CACHE_PATH = Deno.env.get("CACHE_PATH");
const CACHE_TIME = Deno.env.get("CACHE_TIME")
  ? parseInt(Deno.env.get("CACHE_TIME")!, 10)
  : 60 * 60;

const NIP05_NAME_DOMAINS = getList("NIP05_NAME_DOMAINS");
const PUBLIC_DOMAIN = Deno.env.get("PUBLIC_DOMAIN") || undefined;

const NSITE_HOST = Deno.env.get("NSITE_HOST") || "0.0.0.0";
const NSITE_PORT = Deno.env.get("NSITE_PORT")
  ? parseInt(Deno.env.get("NSITE_PORT")!, 10)
  : 3000;
const HOST = `${NSITE_HOST}:${NSITE_PORT}`;

const ONION_HOST = Deno.env.get("ONION_HOST") || undefined;

export {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  CACHE_PATH,
  CACHE_RELAYS,
  CACHE_TIME,
  HOST,
  LOOKUP_RELAYS,
  MAX_FILE_SIZE,
  NIP05_NAME_DOMAINS,
  NSITE_HOMEPAGE,
  NSITE_HOMEPAGE_DIR,
  NSITE_HOST,
  NSITE_PORT,
  ONION_HOST,
  PUBLIC_DOMAIN,
  SUBSCRIPTION_RELAYS,
};
