import { MAX_FILE_SIZE } from "../env.ts";
import logger from "../helpers/debug.ts";
import {
  type VerificationResult,
  verifyStreamInWorker,
} from "./blob-verifier-pool.ts";
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
const invalidBlobLog = log.extend("invalid-blob");
const activeVerifications = new Set<string>();

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

function getVerificationKey(sha256: string, server: string): string {
  return `${sha256}:${server}`;
}

export async function isBadBlobSource(sha256: string, server: string) {
  return !!(await getBadBlobSource(sha256, server));
}

async function filterBadBlobURLs(
  sha256: string,
  urls: string[],
): Promise<string[]> {
  const checks = await Promise.all(
    urls.map(async (url) => ({
      url,
      blocked: await isBadBlobSource(sha256, url),
    })),
  );
  return checks.filter((entry) => !entry.blocked).map((entry) => entry.url);
}

async function filterBadServers(
  sha256: string,
  servers: string[],
): Promise<string[]> {
  const checks = await Promise.all(
    servers.map(async (server) => {
      const url = new URL(sha256, server).toString();
      return { server, blocked: await isBadBlobSource(sha256, url) };
    }),
  );
  return checks.filter((entry) => !entry.blocked).map((entry) => entry.server);
}

export async function markBadBlobSource(
  sha256: string,
  server: string,
  reason = "hash_mismatch",
) {
  await setBadBlobSource(sha256, server, reason);

  const cached = await getBlobServer(sha256);
  if (cached === server) await clearBlobServer(sha256);

  await clearBlobServers(sha256);
}

async function markGoodBlobSource(sha256: string, server: string) {
  await clearBadBlobSource(sha256, server);
}

function scheduleBlobVerification(
  sha256: string,
  server: string,
  stream: ReadableStream<Uint8Array>,
  requestLog: (...data: unknown[]) => void,
) {
  const key = getVerificationKey(sha256, server);
  if (activeVerifications.has(key)) {
    stream.cancel().catch(() => {});
    return;
  }

  activeVerifications.add(key);

  void verifyStreamInWorker(sha256, stream)
    .then(async (result) => {
      if (result.ok) {
        await markGoodBlobSource(sha256, server);
        requestLog(`Verified ${server}: sha256 matched (${result.size} bytes)`);
        return;
      }

      if (result.reason === "hash_mismatch") {
        await markBadBlobSource(sha256, server, result.reason);
        const message =
          `Invalid blob from ${server}: expected sha256=${sha256}, actual sha256=${
            result.actualSha256 ?? "unknown"
          }, size=${result.size ?? "unknown"}`;
        invalidBlobLog(message);
        console.error(`[nsite:blossom:invalid-blob] ${message}`);
        requestLog(
          `Rejected ${server}: sha256 mismatch (${
            result.actualSha256 ?? "unknown"
          })`,
        );
        return;
      }

      requestLog(`Verification failed for ${server}: ${result.reason}`);
    })
    .catch((error) => {
      requestLog(
        `Verifier crashed for ${server}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      activeVerifications.delete(key);
    });
}

export function shouldVerifyBlobResponse(options: {
  method?: string;
  status: number;
  hasRange: boolean;
  hasPreferredSource: boolean;
  server: string;
  preferredSource?: string;
}) {
  if ((options.method ?? "GET") !== "GET") return false;
  if (options.status !== 200) return false;
  if (options.hasRange) return false;
  if (!options.hasPreferredSource) return true;
  return options.server !== options.preferredSource;
}

export async function findBlobURLs(
  sha256: string,
  servers: string[],
  options?: { pubkey?: string; blossomProxy?: string },
): Promise<string[]> {
  const cached = await getBlobServers(sha256);
  if (cached) {
    const filtered = await filterBadBlobURLs(sha256, cached);
    if (filtered.length !== cached.length) {
      await setBlobServers(sha256, filtered);
    }
    return filtered;
  }

  const { pubkey, blossomProxy } = options || {};
  const availableServers = await filterBadServers(sha256, servers);

  const ordered: string[] = [];
  const seen = new Set<string>();

  let proxyUrlString: string | undefined;
  if (blossomProxy) {
    try {
      const proxyUrl = new URL(sha256, blossomProxy);
      const queryParams = buildBud10QueryParams(availableServers, pubkey);
      if (queryParams) proxyUrl.search = queryParams;
      const candidate = proxyUrl.toString();
      if (!(await isBadBlobSource(sha256, candidate))) {
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
  const preferred = cached && !(await isBadBlobSource(sha256, cached))
    ? cached
    : undefined;
  const ordered = preferred
    ? [preferred, ...urls.filter((u) => u !== preferred)]
    : urls;
  const hasPreferredSource = !!preferred;
  const hasRange = new Headers(init?.headers).has("range");

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

        let responseBody = body;
        if (
          shouldVerifyBlobResponse({
            method: init?.method,
            status: response.status,
            hasRange,
            hasPreferredSource,
            server,
            preferredSource: preferred,
          })
        ) {
          const [clientBody, verifyBody] = body.tee();
          responseBody = clientBody;
          scheduleBlobVerification(sha256, server, verifyBody, requestLog);
        }

        // Return new response for the blob
        return new Response(responseBody, {
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
