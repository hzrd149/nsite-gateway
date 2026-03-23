import { MAX_BLOSSOM_SERVERS, MAX_FILE_SIZE } from "../helpers/env.ts";
import logger from "../helpers/debug.ts";
import { blobURLs } from "./cache.ts";

const log = logger.extend("blossom");
export const BLOB_SOURCE_HEADER = "X-Blob-Source";

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
    if (ordered.length >= MAX_BLOSSOM_SERVERS) break;
    const url = new URL(sha256, server).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    ordered.push(url);
  }

  await blobURLs.set(sha256, ordered);
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

  let lastFailure: string | undefined;

  for (const urlString of urls) {
    try {
      const controller = new AbortController();
      const response = await fetch(urlString, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          controller.signal,
        ]),
      });

      const length = response.headers.get("content-length");
      if (length && Number(length) > MAX_FILE_SIZE) {
        requestLog(`Rejected ${urlString}: file too large (${length})`);
        lastFailure = "file-too-large";
        controller.abort();
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        if (!response.body || init?.method === "HEAD") {
          const headers = new Headers(response.headers);
          headers.set(BLOB_SOURCE_HEADER, urlString);
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        const body = limitBodySize(response.body, MAX_FILE_SIZE, () => {
          requestLog(
            `Aborted ${urlString}: stream exceeded ${MAX_FILE_SIZE} bytes`,
          );
          lastFailure = "stream-too-large";
          controller.abort();
        });

        const headers = new Headers(response.headers);
        headers.set(BLOB_SOURCE_HEADER, urlString);

        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      requestLog(
        `Failed ${urlString}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return undefined;
}
