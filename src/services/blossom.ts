import { BLOB_CACHE_OPTIONS } from "../env.ts";
import { isBlobHash, parseBlossomURL } from "../helpers/blossom.ts";
import logger from "../helpers/debug.ts";
import {
  type BlobObservation,
  logFields,
  logValue,
} from "../helpers/request-log.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import {
  CacheAdmissionError,
  VerifiedBlobCache,
} from "./verified-blob-cache.ts";
import {
  clearBadBlobSource,
  clearBlobServer,
  clearBlobServers,
  getBadBlobSource,
  getBlobServer,
  getBlobServers,
  setBadBlobSource,
  setBlobServer,
  setBlobServers,
} from "./cache.ts";

const log = logger.extend("blossom");
export const verifiedBlobCache = new VerifiedBlobCache(BLOB_CACHE_OPTIONS);
onShutdown(() => verifiedBlobCache.close());

function extractDomain(serverUrl: string): string {
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl.replace(/^https?:\/\//, "");
  }
}

function buildBud10QueryParams(allServers: string[], pubkey?: string): string {
  const params = new URLSearchParams();
  for (const server of allServers) params.append("xs", extractDomain(server));
  if (pubkey) params.append("as", pubkey);
  return params.toString();
}

export async function isBadBlobSource(
  pubkey: string,
  sha256: string,
  server: string,
) {
  return !!(await getBadBlobSource(pubkey, sha256, server));
}

async function filterBadBlobURLs(
  pubkey: string,
  sha256: string,
  urls: string[],
): Promise<string[]> {
  const checks = await Promise.all(
    urls.map(async (url) => ({
      url,
      blocked: !parseBlossomURL(url) ||
        await isBadBlobSource(pubkey, sha256, url),
    })),
  );
  return checks.filter((entry) => !entry.blocked).map((entry) => entry.url);
}

async function filterBadServers(
  pubkey: string,
  sha256: string,
  servers: string[],
): Promise<string[]> {
  const checks = await Promise.all(
    servers.map(async (server) => {
      if (!parseBlossomURL(server)) return { server, blocked: true };
      const url = new URL(sha256, server).toString();
      return { server, blocked: await isBadBlobSource(pubkey, sha256, url) };
    }),
  );
  return checks.filter((entry) => !entry.blocked).map((entry) => entry.server);
}

export async function markBadBlobSource(
  pubkey: string,
  sha256: string,
  server: string,
  reason = "hash_mismatch",
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await setBadBlobSource(pubkey, sha256, server, reason);

  signal?.throwIfAborted();
  const cached = await getBlobServer(pubkey, sha256);
  signal?.throwIfAborted();
  if (cached === server) await clearBlobServer(pubkey, sha256);

  signal?.throwIfAborted();
  await clearBlobServers(pubkey, sha256);
}

async function markGoodBlobSource(
  pubkey: string,
  sha256: string,
  server: string,
) {
  await clearBadBlobSource(pubkey, sha256, server);
}

export async function findBlobURLs(
  sha256: string,
  servers: string[],
  options: { pubkey: string; blossomProxy?: string; signal?: AbortSignal },
): Promise<string[]> {
  if (!isBlobHash(sha256)) return [];
  const { pubkey, blossomProxy, signal } = options;
  signal?.throwIfAborted();
  const cached = await getBlobServers(pubkey, sha256);
  signal?.throwIfAborted();
  if (cached) {
    const filtered = await filterBadBlobURLs(pubkey, sha256, cached);
    signal?.throwIfAborted();
    if (filtered.length !== cached.length) {
      await setBlobServers(pubkey, sha256, filtered);
    }
    return filtered;
  }

  const availableServers = await filterBadServers(pubkey, sha256, servers);
  signal?.throwIfAborted();

  const ordered: string[] = [];
  const seen = new Set<string>();

  let proxyUrlString: string | undefined;
  if (blossomProxy && parseBlossomURL(blossomProxy)) {
    try {
      const proxyUrl = new URL(sha256, blossomProxy);
      const queryParams = buildBud10QueryParams(availableServers, pubkey);
      if (queryParams) proxyUrl.search = queryParams;
      const candidate = proxyUrl.toString();
      if (!(await isBadBlobSource(pubkey, sha256, candidate))) {
        proxyUrlString = candidate;
      }
    } catch (error) {
      log.extend(sha256.slice(0, 6))(
        `Failed to build BLOSSOM_PROXY URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (proxyUrlString) {
    ordered.push(proxyUrlString);
    seen.add(proxyUrlString);
  }

  for (const server of availableServers) {
    const url = new URL(sha256, server).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    ordered.push(url);
  }

  signal?.throwIfAborted();
  await setBlobServers(pubkey, sha256, ordered);
  return ordered;
}

export async function streamBlob(
  sha256: string,
  servers: string[],
  init: {
    method?: string;
    headers?: HeadersInit;
    pubkey: string;
    blossomProxy?: string;
    signal?: AbortSignal;
    observation?: BlobObservation;
    /** Called with the source URL that filled the cache for this blob */
    onSource?: (server: string) => void;
  },
): Promise<Response | undefined> {
  if (!isBlobHash(sha256)) return undefined;
  const { pubkey } = init;
  try {
    return await verifiedBlobCache.response(sha256, {
      publisher: pubkey,
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      observation: init.observation,
      sources: async (signal) => {
        const urls = await findBlobURLs(sha256, servers, { ...init, signal });
        signal.throwIfAborted();
        const cached = await getBlobServer(pubkey, sha256);
        signal.throwIfAborted();
        const preferred = cached && parseBlossomURL(cached) &&
            !(await isBadBlobSource(pubkey, sha256, cached))
          ? cached
          : undefined;
        // A preferred source is only an ordering hint, never a verification exemption.
        signal.throwIfAborted();
        await clearBlobServer(pubkey, sha256);
        return preferred
          ? [preferred, ...urls.filter((url) => url !== preferred)]
          : urls;
      },
      good: async (source, signal) => {
        signal.throwIfAborted();
        await markGoodBlobSource(pubkey, sha256, source);
        signal.throwIfAborted();
        await setBlobServer(pubkey, sha256, source);
        init.onSource?.(source);
      },
      bad: (source, signal) =>
        markBadBlobSource(pubkey, sha256, source, "hash_mismatch", signal),
    });
  } catch (error) {
    if (error instanceof CacheAdmissionError) {
      log(
        "Admission rejected: %s; %s",
        logValue(error),
        logFields(verifiedBlobCache.metrics),
      );
      return new Response("Verified cache busy; retry later.", {
        status: 503,
        headers: { "Retry-After": "5", "Cache-Control": "no-store" },
      });
    }
    if (init.signal?.aborted) throw error;
    log("Cache fill failed: %s", logValue(error));
    return undefined;
  }
}
