import { IncomingMessage } from "node:http";

import { BLOSSOM_PROXY, MAX_FILE_SIZE } from "./env.js";
import { makeRequestWithAbort } from "./helpers/http.js";
import { blobURLs } from "./cache.js";
import logger from "./logger.js";

const log = logger.extend("blossom");

if (BLOSSOM_PROXY) log(`Using blossom proxy: ${BLOSSOM_PROXY}`);

/**
 * Extracts domain name from a server URL (removes protocol)
 */
function extractDomain(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return url.hostname;
  } catch {
    // If it's not a full URL, assume it's already a domain
    return serverUrl.replace(/^https?:\/\//, "");
  }
}

/**
 * Builds BUD-10 query parameters for blossom proxy
 */
function buildBud10QueryParams(allServers: string[], pubkey?: string): string {
  const params = new URLSearchParams();

  // Add xs (server hints) - extract domains from all servers
  for (const server of allServers) {
    const domain = extractDomain(server);
    params.append("xs", domain);
  }

  // Add as (author) if pubkey is provided
  if (pubkey) {
    params.append("as", pubkey);
  }

  return params.toString();
}

/** Checks all servers for a blob and returns the URLs */
export async function findBlobURLs(
  sha256: string,
  servers: string[],
  options?: {
    pubkey?: string;
    blossomProxy?: string;
  },
): Promise<string[]> {
  const cache = await blobURLs.get(sha256);
  if (cache) return cache;

  const id = sha256.slice(0, 6);
  const requestLog = log.extend(id);

  const { pubkey, blossomProxy } = options || {};

  // Build proxy URL if provided (always try proxy first without checking)
  let proxyUrlString: string | null = null;
  if (blossomProxy) {
    try {
      const proxyUrl = new URL(sha256, blossomProxy);
      // Add BUD-10 query parameters
      const queryParams = buildBud10QueryParams(servers, pubkey);
      if (queryParams) {
        proxyUrl.search = queryParams;
      }
      proxyUrlString = proxyUrl.toString();
      requestLog(`Will try blossom proxy first: ${proxyUrl.hostname}`);
    } catch (error) {
      requestLog(`✗ Failed to build BLOSSOM_PROXY URL: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  requestLog(`Checking ${servers.length} servers`);
  const results = await Promise.all(
    servers.map(async (server) => {
      const url = new URL(sha256, server);
      const domain = url.hostname;

      try {
        const check = await fetch(url, { method: "HEAD" });
        if (check.status === 200) {
          requestLog(`✓ ${domain} - HTTP ${check.status} (success)`);
          return url.toString();
        } else {
          requestLog(`✗ ${domain} - HTTP ${check.status} (failed)`);
          return null;
        }
      } catch (error) {
        requestLog(`✗ ${domain} - Network error: ${error instanceof Error ? error.message : "Unknown error"}`);
        return null;
      }
    }),
  );

  const filtered = results.filter((url) => url !== null);

  // Always prepend proxy URL if set (try proxy first)
  const finalUrls = proxyUrlString ? [proxyUrlString, ...filtered] : filtered;

  requestLog(`Found ${filtered.length}/${servers.length} servers${proxyUrlString ? " (+ proxy)" : ""}`);
  await blobURLs.set(sha256, finalUrls);
  return finalUrls;
}

/** Downloads a file from multiple servers with optional range support */
export async function streamBlob(
  sha256: string,
  servers: string[],
  headers?: Record<string, string>,
  options?: {
    pubkey?: string;
    blossomProxy?: string;
  },
): Promise<IncomingMessage | undefined> {
  const id = sha256.slice(0, 6);
  const streamLog = log.extend(id);

  if (servers.length === 0) {
    streamLog(`No servers provided for blob ${sha256}`);
    return undefined;
  }

  const { pubkey, blossomProxy } = options || {};

  streamLog(`Starting blob stream for ${sha256} from ${servers.length} servers`);

  // First find all available URLs (including BLOSSOM_PROXY if configured)
  const urls = await findBlobURLs(sha256, servers, { pubkey, blossomProxy });
  if (urls.length === 0) {
    streamLog(`No available URLs found for blob ${sha256}`);
    return undefined;
  }

  streamLog(`Attempting to stream from ${urls.length} available URLs`);

  // Try each URL sequentially with timeout
  for (let i = 0; i < urls.length; i++) {
    const urlString = urls[i];
    const url = new URL(urlString);
    const domain = url.hostname;

    streamLog(`Trying server ${i + 1}/${urls.length}: ${domain}`);

    const controller = new AbortController();
    let res: IncomingMessage | undefined = undefined;

    try {
      // Set up timeout to abort after 10s
      const timeout = setTimeout(() => {
        streamLog(`Request to ${domain} timed out after 10s`);
        controller.abort();
      }, 10_000);

      // URL already has query parameters from findBlobURLs if it's the proxy
      const response = await makeRequestWithAbort(url, controller, headers);
      res = response;
      clearTimeout(timeout);

      if (!response.statusCode) {
        throw new Error("Missing headers or status code");
      }

      const size = response.headers["content-length"];
      if (size && parseInt(size) > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${size} bytes (max: ${MAX_FILE_SIZE})`);
      }

      // Accept both 200 (full content) and 206 (partial content) status codes
      if (response.statusCode >= 200 && response.statusCode < 300) {
        streamLog(`✓ ${domain} - HTTP ${response.statusCode} - Successfully streaming blob ${sha256}`);
        return response;
      } else {
        throw new Error(`HTTP ${response.statusCode}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      streamLog(`✗ ${domain} - Failed: ${errorMessage}`);

      if (res) res.resume();
      continue; // Try next URL if this one fails
    }
  }

  streamLog(`All servers failed for blob ${sha256}`);
  return undefined;
}
