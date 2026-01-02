import { extname, join } from "path";
import { pathBlobs, siteManifests } from "./cache.js";
import { loadEvents, loadManifest } from "./nostr.js";
import { NostrEvent } from "nostr-tools";

export type ParsedEvent = {
  pubkey: string;
  path: string;
  sha256: string;
  created_at: number;
};

export type ParsedManifest = {
  pubkey: string;
  identifier: string;
  paths: Map<string, string>; // path -> sha256
  servers: string[];
  title?: string;
  description?: string;
  created_at: number;
};

/** Returns all the `d` tags that should be searched for a given path */
export function getSearchPaths(path: string) {
  const paths = [path];

  // if the path does not have an extension, also look for index.html
  if (extname(path) === "") paths.push(join(path, "index.html"));

  return paths.filter((p) => !!p);
}

/**
 * Parses a legacy kind 34128 event (individual file)
 */
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

/**
 * Parses a site manifest event
 * - Kind 15128: Root site (no identifier) - identifier will be ""
 * - Kind 35128: Identifier-specific site - identifier comes from d tag (must be non-empty)
 */
export function parseManifestEvent(event: NostrEvent): ParsedManifest | undefined {
  let identifier: string | undefined;

  if (event.kind === 15128) {
    // Kind 15128: Root site - identifier is always empty string
    identifier = "";
  } else {
    // Kind 35128: Identifier-specific site - identifier MUST come from d tag and MUST be non-empty
    const dTag = event.tags.find((t) => t[0] === "d" && t[1] !== undefined)?.[1];

    // Reject if d tag is missing or empty - kind 35128 events with "" d tags are invalid
    if (!dTag || dTag === "") return undefined;

    identifier = dTag;
  }

  if (identifier === undefined) return undefined;

  // Extract all path tags
  const paths = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === "path" && tag[1] && tag[2]) {
      const path = join("/", tag[1]);
      const sha256 = tag[2];
      paths.set(path, sha256);
    }
  }

  // Extract server hints
  const servers = event.tags.filter((t) => t[0] === "server" && t[1]).map((t) => t[1]);

  // Extract metadata
  const title = event.tags.find((t) => t[0] === "title")?.[1];
  const description = event.tags.find((t) => t[0] === "description")?.[1];

  return {
    pubkey: event.pubkey,
    identifier,
    paths,
    servers,
    title,
    description,
    created_at: event.created_at,
  };
}

/**
 * Returns the blob info for a given path
 * - First tries to load from site manifest (kind 15128 for root site, kind 35128 for identifier sites)
 * - Falls back to legacy individual file events (kind 34128)
 *
 * @param identifier - Empty string "" for root site, or the site identifier for identifier-specific sites
 */
export async function getNsiteBlob(
  pubkey: string,
  path: string,
  relays: string[],
  identifier: string = "",
): Promise<(ParsedEvent & { servers?: string[] }) | undefined> {
  const key = `${pubkey}:${identifier}:${path}`;

  const cached = await pathBlobs.get(key);
  if (cached) return cached;

  // Try to load site manifest first
  // - identifier === "" → queries kind 15128 (root site)
  // - identifier !== "" → queries kind 35128 (identifier-specific site)
  const manifest = await loadManifest(pubkey, identifier, relays);

  if (manifest) {
    const parsedManifest = parseManifestEvent(manifest);
    if (parsedManifest) {
      // NOTE: hack, remove "/" paths since it breaks some relays
      const paths = getSearchPaths(path).filter((p) => p !== "/");

      // Try to find the path in the manifest
      for (const searchPath of paths) {
        const sha256 = parsedManifest.paths.get(searchPath);
        if (sha256) {
          const result = {
            pubkey,
            path: searchPath,
            sha256,
            created_at: parsedManifest.created_at,
            servers: parsedManifest.servers.length > 0 ? parsedManifest.servers : undefined,
          };

          await pathBlobs.set(key, result);
          return result;
        }
      }
    }
  }

  // Fall back to legacy kind 34128 events
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
