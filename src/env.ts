import xbytes from "xbytes";
import { relaySet } from "applesauce-core/helpers";

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

/** Nostr relays to use for lookup and cache */
export const LOOKUP_RELAYS = relaySet(getList("LOOKUP_RELAYS", [
  "wss://user.kindpag.es/",
  "wss://purplepag.es/",
]));

/** Extra nostr relays to use for loading site manifests */
export const NOSTR_RELAYS = relaySet(getList("NOSTR_RELAYS"));

const LOCAL_CACHE_RELAY = "ws://localhost:4869";
const LOCAL_BLOSSOM_PROXY = "http://localhost:24242";

export const CACHE_RELAYS = Deno.env.get("CACHE_RELAYS")
  ? getList("CACHE_RELAYS")
  : (await checkLocalHttp("http://localhost:4869"))
  ? [LOCAL_CACHE_RELAY]
  : undefined;

export const BLOSSOM_SERVERS = getList("BLOSSOM_SERVERS");

export const BLOSSOM_PROXY = Deno.env.get("BLOSSOM_PROXY")?.trim() ||
  ((await checkLocalHttp(LOCAL_BLOSSOM_PROXY))
    ? LOCAL_BLOSSOM_PROXY
    : undefined);

export const MAX_FILE_SIZE = Deno.env.get("MAX_FILE_SIZE")
  ? xbytes.parseSize(Deno.env.get("MAX_FILE_SIZE")!)
  : 128 * 1024 * 1024;

export const CACHE_PATH = Deno.env.get("CACHE_PATH");
export const CACHE_TIME = Deno.env.get("CACHE_TIME")
  ? parseInt(Deno.env.get("CACHE_TIME")!, 10)
  : 60 * 60;

export const PUBLIC_DOMAIN = Deno.env.get("PUBLIC_DOMAIN");

export const NSITE_HOST = Deno.env.get("NSITE_HOST") || "0.0.0.0";
export const NSITE_PORT = Deno.env.get("NSITE_PORT")
  ? parseInt(Deno.env.get("NSITE_PORT")!, 10)
  : 3000;
export const HOST = `${NSITE_HOST}:${NSITE_PORT}`;

export const ONION_HOST = Deno.env.get("ONION_HOST");
