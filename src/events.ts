import { extname, join } from "@std/path/posix";
import type { NostrEvent } from "nostr-tools";
import { pathBlobs, siteManifests } from "./cache.ts";
import { loadEvents, loadManifest } from "./nostr.ts";
import type { RequestLog } from "./request-log.ts";
import { formatAgeFromUnix, shortId } from "./request-log.ts";

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
  source: "manifest" | "legacy";
  manifestId?: string;
};

function addManifestLogFields(requestLog: RequestLog | undefined, event: {
  id?: string;
  created_at: number;
}) {
  if (!requestLog || !event.id) return;
  requestLog.addFields({
    manifest: shortId(event.id, 12),
    manifestAge: formatAgeFromUnix(event.created_at),
  });
}

export function getSearchPaths(path: string) {
  const paths = [path];
  if (extname(path) === "") paths.push(join(path, "index.html"));
  return paths.filter(Boolean);
}

export function parseNsiteEvent(
  event: { pubkey: string; tags: string[][]; created_at: number },
) {
  const path = event.tags.find((t) => t[0] === "d" && t[1])?.[1];
  const sha256 = event.tags.find((t) => t[0] === "x" && t[1])?.[1];

  if (path && sha256) {
    return {
      pubkey: event.pubkey,
      path: join("/", path),
      sha256,
      created_at: event.created_at,
    };
  }
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

export async function getNsiteBlob(
  pubkey: string,
  path: string,
  relays: string[],
  identifier = "",
  requestLog?: RequestLog,
): Promise<NsiteBlobResult | undefined> {
  const key = `${pubkey}:${identifier}:${path}`;
  const cached = await pathBlobs.get(key);
  if (cached) {
    if (cached.source === "manifest") {
      addManifestLogFields(requestLog, {
        id: cached.manifestId,
        created_at: cached.created_at,
      });
    }
    return { ...cached, source: cached.source || "legacy" };
  }

  const manifest = await loadManifest(pubkey, identifier, relays);
  if (manifest) {
    const parsedManifest = parseManifestEvent(manifest);
    if (parsedManifest) {
      const paths = getSearchPaths(path).filter((entry) => entry !== "/");
      for (const searchPath of paths) {
        const sha256 = parsedManifest.paths.get(searchPath);
        if (!sha256) continue;

        const result = {
          pubkey,
          path: searchPath,
          sha256,
          created_at: parsedManifest.created_at,
          source: "manifest" as const,
          manifestId: manifest.id,
          servers: parsedManifest.servers.length > 0
            ? parsedManifest.servers
            : undefined,
        };
        addManifestLogFields(requestLog, manifest);
        await pathBlobs.set(key, result);
        return result;
      }
    }
  }

  requestLog?.addFields({ src: "legacy" });

  const allEvents = await loadEvents(pubkey, relays);
  const paths = getSearchPaths(path).filter((entry) => entry !== "/");
  const matchingEvents = allEvents.filter((event) =>
    paths.includes(event.path)
  );
  const options = matchingEvents.sort((a, b) =>
    paths.indexOf(a.path) - paths.indexOf(b.path)
  );
  if (options.length > 0) {
    const result = { ...options[0], source: "legacy" as const };
    await pathBlobs.set(key, result);
    return result;
  }
  return undefined;
}
