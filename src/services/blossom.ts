import { MAX_FILE_SIZE } from "../env.ts";
import logger from "../helpers/debug.ts";
import {
  clearBlobServer,
  getBlobServer,
  getBlobServers,
  setBlobServer,
  setBlobServers,
} from "./cache.ts";

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
  const cached = await getBlobServers(sha256);
  if (cached) return cached;

  const { pubkey, blossomProxy } = options || {};

  const ordered: string[] = [];
  const seen = new Set<string>();

  let proxyUrlString: string | undefined;
  if (blossomProxy) {
    try {
      const proxyUrl = new URL(sha256, blossomProxy);
      const queryParams = buildBud10QueryParams(servers, pubkey);
      if (queryParams) proxyUrl.search = queryParams;
      proxyUrlString = proxyUrl.toString();
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

  for (const server of servers) {
    const url = new URL(sha256, server).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    ordered.push(url);
  }

  await setBlobServers(sha256, ordered);
  return ordered;
}

function limitBodySize(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): ReadableStream<Uint8Array> {
  let bytes = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          onLimit();
          controller.error(
            new Error(`Blob exceeds maximum allowed size of ${maxBytes} bytes`),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
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

  const cached = await getBlobServer(sha256);
  const ordered = cached ? [cached, ...urls.filter((u) => u !== cached)] : urls;

  for (const server of ordered) {
    try {
      const controller = new AbortController();
      const response = await fetch(server, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          controller.signal,
        ]),
      });

      const length = response.headers.get("content-length");
      if (length && Number(length) > MAX_FILE_SIZE) {
        requestLog(`Rejected ${server}: file too large (${length})`);
        controller.abort();
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        // Set the server as the current live server for the blob
        setBlobServer(sha256, server).catch(() => {});

        if (!response.body || init?.method === "HEAD") {
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        // Limit the body size to the maximum allowed size
        const body = limitBodySize(response.body, MAX_FILE_SIZE, () => {
          requestLog(
            `Aborted ${server}: stream exceeded ${MAX_FILE_SIZE} bytes`,
          );
          controller.abort();
        });

        // Return new response for the blob
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (error) {
      requestLog(
        `Failed ${server}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // No server worked, clear cached server
    clearBlobServer(sha256).catch(() => {});
  }

  return undefined;
}
