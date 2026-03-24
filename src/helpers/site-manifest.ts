import { extname, join } from "@std/path/posix";
import {
  getBlossomServersFromList,
  getRelaysFromList,
} from "applesauce-common/helpers";
import {
  getOrComputeCachedValue,
  getReplaceableIdentifier,
  getTagValue,
  type NostrEvent,
} from "applesauce-core/helpers";

export const ROOT_SITE_MANIFEST_KIND = 15128;
export const NAMED_SITE_MANIFEST_KIND = 35128;

export const ManifestPathsSymbol = Symbol.for("ManifestPaths");

/** Gets the path map of a manifest event */
export function getManifestPaths(manifest: NostrEvent): Map<string, string> {
  return getOrComputeCachedValue(
    manifest,
    ManifestPathsSymbol,
    () =>
      manifest.tags.filter((t) => t[0] === "path" && t[1]).reduce(
        (map, tag) => {
          map.set(join("/", tag[1]), tag[2]);
          return map;
        },
        new Map<string, string>(),
      ),
  );
}

export type ManifestPathMatch = {
  path: string;
  sha256: string;
  is404: boolean;
};

/** Resolves a request path to a manifest path and sha256 hash */
export function resolveManifestPath(
  manifest: NostrEvent,
  requestPath: string,
): ManifestPathMatch | undefined {
  const paths = getManifestPaths(manifest);
  const normalized = join("/", requestPath);

  // Check for exact match
  const exact = paths.get(normalized);
  if (exact) return { path: normalized, sha256: exact, is404: false };

  // Check for index.html fallback
  if (extname(normalized) === "") {
    const indexPath = join(normalized, "index.html");
    const index = paths.get(indexPath);
    if (index) return { path: indexPath, sha256: index, is404: false };
  }

  // Check for 404 fallback
  const notFound = paths.get("/404.html");
  if (notFound) {
    return { path: "/404.html", sha256: notFound, is404: true };
  }

  return undefined;
}

/** Returns the relays listed in a manifest event */
export function getManifestRelays(manifest: NostrEvent): string[] {
  return getRelaysFromList(manifest);
}

/** Returns the servers listed in a manifest event */
export function getManifestServers(manifest: NostrEvent): string[] {
  return getBlossomServersFromList(manifest).map((url) => url.toString());
}

/** Returns the identifier of a manifest event */
export function getManifestIdentifier(manifest: NostrEvent): string | null {
  return manifest.kind === ROOT_SITE_MANIFEST_KIND
    ? null
    : getReplaceableIdentifier(manifest);
}

export function getManifestTitle(manifest: NostrEvent): string | undefined {
  return getTagValue(manifest, "title");
}

export function getManifestDescription(
  manifest: NostrEvent,
): string | undefined {
  return getTagValue(manifest, "description");
}

export function getManifestSource(manifest: NostrEvent): string | undefined {
  return getTagValue(manifest, "source");
}
