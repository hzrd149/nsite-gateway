import { extname, join } from "path";
import { pathBlobs } from "./cache.js";
import { loadEvents } from "./nostr.js";

export type ParsedEvent = {
  pubkey: string;
  path: string;
  sha256: string;
  created_at: number;
};

/** Returns all the `d` tags that should be searched for a given path */
export function getSearchPaths(path: string) {
  const paths = [path];

  // if the path does not have an extension, also look for index.html
  if (extname(path) === "") paths.push(join(path, "index.html"));

  return paths.filter((p) => !!p);
}

export function parseNsiteEvent(event: { pubkey: string; tags: string[][]; created_at: number }) {
  const path = event.tags.find((t) => t[0] === "d" && t[1])?.[1];
  const sha256 = event.tags.find((t) => t[0] === "x" && t[1])?.[1];

  if (path && sha256)
    return {
      pubkey: event.pubkey,
      path: join("/", path),
      sha256,
      created_at: event.created_at,
    };
}

/** Returns the first blob found for a given path */
export async function getNsiteBlob(pubkey: string, path: string, relays: string[]): Promise<ParsedEvent | undefined> {
  const key = pubkey + path;

  const cached = await pathBlobs.get(key);
  if (cached) return cached;

  // Load all events for this pubkey (uses cache if available)
  const allEvents = await loadEvents(pubkey, relays);

  // NOTE: hack, remove "/" paths since it breaks some relays
  const paths = getSearchPaths(path).filter((p) => p !== "/");

  // Find matching events from the loaded events
  const matchingEvents = allEvents.filter((e) => paths.includes(e.path));

  // Sort the found blobs by the order of the paths array
  const options = matchingEvents.sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path));

  // Remember the blob for this path
  if (options.length > 0) await pathBlobs.set(key, options[0]);

  return options[0];
}
