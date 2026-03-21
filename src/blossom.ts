import { blobURLs } from "./cache.ts";
import { MAX_FILE_SIZE } from "./env.ts";
import logger from "./logger.ts";

const log = logger.extend("blossom");

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

export async function findBlobURLs(
  sha256: string,
  servers: string[],
  options?: { pubkey?: string; blossomProxy?: string },
): Promise<string[]> {
  const cached = await blobURLs.get(sha256);
  if (cached) return cached;

  const requestLog = log.extend(sha256.slice(0, 6));
  const { pubkey, blossomProxy } = options || {};

  let proxyUrlString: string | null = null;
  if (blossomProxy) {
    try {
      const proxyUrl = new URL(sha256, blossomProxy);
      const queryParams = buildBud10QueryParams(servers, pubkey);
      if (queryParams) proxyUrl.search = queryParams;
      proxyUrlString = proxyUrl.toString();
    } catch (error) {
      requestLog(
        `Failed to build BLOSSOM_PROXY URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const results = await Promise.all(
    servers.map(async (server) => {
      const url = new URL(sha256, server);
      try {
        const response = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok ? url.toString() : null;
      } catch {
        return null;
      }
    }),
  );

  const finalUrls = results.filter((url): url is string => Boolean(url));
  const ordered = proxyUrlString ? [proxyUrlString, ...finalUrls] : finalUrls;
  await blobURLs.set(sha256, ordered);
  return ordered;
}

export async function streamBlob(
  sha256: string,
  servers: string[],
  init?: {
    method?: string;
    headers?: HeadersInit;
    pubkey?: string;
    blossomProxy?: string;
  },
): Promise<Response | undefined> {
  if (servers.length === 0) return undefined;

  const requestLog = log.extend(sha256.slice(0, 6));
  const urls = await findBlobURLs(sha256, servers, {
    pubkey: init?.pubkey,
    blossomProxy: init?.blossomProxy,
  });
  if (urls.length === 0) return undefined;

  for (const urlString of urls) {
    try {
      const response = await fetch(urlString, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        signal: AbortSignal.timeout(10_000),
      });

      const length = response.headers.get("content-length");
      if (length && Number(length) > MAX_FILE_SIZE) {
        requestLog(`Rejected ${urlString}: file too large (${length})`);
        continue;
      }

      if (response.status >= 200 && response.status < 300) return response;
    } catch (error) {
      requestLog(
        `Failed ${urlString}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return undefined;
}
