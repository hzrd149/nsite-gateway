import { extname, join } from "@std/path/posix";
import type { NostrEvent } from "nostr-tools";
import { manifestPaths, pathBlobs, siteManifests } from "../services/cache.ts";
import { loadManifest } from "../services/nostr.ts";
import type { RequestLog } from "./request-log.ts";
import { shortId } from "./request-log.ts";

export type ParsedEvent = {
  pubkey: string;
  path: string;
  sha256: string;
  created_at: number;
};

export type ParsedManifest = {
  pubkey: string;
  identifier: string;
  paths: Map<string, string>;
  servers: string[];
  title?: string;
  description?: string;
  created_at: number;
};

export type NsiteBlobResult = ParsedEvent & {
  servers?: string[];
  source: "manifest";
  manifestId?: string;
};

export type NsiteLookupResult =
  | {
    kind: "hit";
    event: NsiteBlobResult;
  }
  | {
    kind: "manifest-miss";
  }
  | {
    kind: "miss";
  };

function addManifestLogFields(requestLog: RequestLog | undefined, event: {
  id?: string;
  created_at: number;
}) {
  if (!requestLog || !event.id) return;
  requestLog.addFields({
    manifest: shortId(event.id, 12),
  });
}

export function getSearchPaths(path: string) {
  const paths = [path];
  if (extname(path) === "") paths.push(join(path, "index.html"));
  return paths.filter(Boolean);
}

export function getPathBlobCacheKey(
  pubkey: string,
  identifier: string,
  path: string,
) {
  return `${pubkey}:${identifier}:${path}`;
}

function getManifestLookupPaths(path: string) {
  const paths = new Set([path]);
  if (path === "/index.html") paths.add("/");
  else if (path.endsWith("/index.html")) {
    const directory = path.slice(0, -"/index.html".length);
    if (directory) {
      paths.add(directory);
      paths.add(`${directory}/`);
    }
  }
  return [...paths];
}

export function parseManifestEvent(
  event: NostrEvent,
): ParsedManifest | undefined {
  let identifier: string | undefined;

  if (event.kind === 15128) identifier = "";
  else {
    const dTag = event.tags.find((t) => t[0] === "d" && t[1] !== undefined)
      ?.[1];
    if (!dTag || dTag === "") return undefined;
    identifier = dTag;
  }

  if (identifier === undefined) return undefined;

  const paths = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] === "path" && tag[1] && tag[2]) {
      paths.set(join("/", tag[1]), tag[2]);
    }
  }

  return {
    pubkey: event.pubkey,
    identifier,
    paths,
    servers: event.tags.filter((t) => t[0] === "server" && t[1]).map((t) =>
      t[1]
    ),
    title: event.tags.find((t) => t[0] === "title")?.[1],
    description: event.tags.find((t) => t[0] === "description")?.[1],
    created_at: event.created_at,
  };
}

export async function cacheManifestEvent(
  manifest: NostrEvent,
): Promise<ParsedManifest | undefined> {
  const parsedManifest = parseManifestEvent(manifest);
  if (!parsedManifest) return undefined;

  const siteKey = `${parsedManifest.pubkey}:${parsedManifest.identifier}`;
  const previousPaths = await manifestPaths.get(siteKey) || [];
  for (const path of previousPaths) {
    pathBlobs.delete(
      getPathBlobCacheKey(
        parsedManifest.pubkey,
        parsedManifest.identifier,
        path,
      ),
    );
  }

  const cachedPaths = new Set<string>();
  const servers = parsedManifest.servers.length > 0
    ? parsedManifest.servers
    : undefined;
  const writes: Promise<void>[] = [siteManifests.set(siteKey, manifest)];

  for (const [path, sha256] of parsedManifest.paths) {
    const result = {
      pubkey: parsedManifest.pubkey,
      path,
      sha256,
      created_at: parsedManifest.created_at,
      source: "manifest" as const,
      manifestId: manifest.id,
      servers,
    };

    for (const lookupPath of getManifestLookupPaths(path)) {
      cachedPaths.add(lookupPath);
      writes.push(
        pathBlobs.set(
          getPathBlobCacheKey(
            parsedManifest.pubkey,
            parsedManifest.identifier,
            lookupPath,
          ),
          result,
        ),
      );
    }
  }

  writes.push(manifestPaths.set(siteKey, [...cachedPaths]));
  await Promise.all(writes);
  return parsedManifest;
}

export async function getNsiteBlob(
  pubkey: string,
  path: string,
  relays: string[],
  identifier = "",
  requestLog?: RequestLog,
): Promise<NsiteLookupResult> {
  requestLog?.addFields({ site: identifier || "root" });
  const key = getPathBlobCacheKey(pubkey, identifier, path);
  const cached = await pathBlobs.get(key);
  if (cached?.manifestId) {
    addManifestLogFields(requestLog, {
      id: cached.manifestId,
      created_at: cached.created_at,
    });
    return {
      kind: "hit",
      event: { ...cached, source: "manifest" },
    };
  }

  const manifest = await loadManifest(pubkey, identifier, relays);
  if (manifest) {
    const parsedManifest = await cacheManifestEvent(manifest);
    if (parsedManifest) {
      const refreshed = await pathBlobs.get(key);
      if (refreshed?.manifestId) {
        addManifestLogFields(requestLog, manifest);
        return { kind: "hit", event: { ...refreshed, source: "manifest" } };
      }

      requestLog?.addFields({ src: "manifest" });
      return { kind: "manifest-miss" };
    }
  }

  return { kind: "miss" };
}
