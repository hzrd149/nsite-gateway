// Prototype: not yet used by the production Blossom transport.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { parseBlossomURL } from "./blossom.ts";

const blocked = new BlockList();
for (
  const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
) blocked.addSubnet(address, prefix, "ipv4");

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
for (
  const [address, prefix] of [
    ["2001::", 23], // Special-purpose assignments, including Teredo.
    ["2001:db8::", 32],
    ["2002::", 16], // 6to4 can encode private IPv4 destinations.
    ["3fff::", 20],
  ] as const
) blocked.addSubnet(address, prefix, "ipv6");

/** Conservative public-unicast policy, including rejection of mapped IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalIPv6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6");
}

type Address = { address: string; family: number };
type Resolve = (hostname: string) => Promise<Address[]>;

async function resolveWithSignal(
  resolve: Resolve,
  hostname: string,
  signal: AbortSignal,
): Promise<Address[]> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * One pinned GET/HEAD request. Redirects remain the caller's responsibility.
 * Trusted origins are operator configuration, never manifest/server-list data.
 * This prototype deliberately avoids connection pooling and address retries.
 */
export function createPinnedFetch(options: {
  resolve?: Resolve;
  trustedOrigins?: string[];
  ca?: string;
} = {}) {
  const resolve = options.resolve ??
    ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const trusted = new Set(options.trustedOrigins);

  return async (
    source: string,
    init: { method?: string; headers?: HeadersInit; signal: AbortSignal },
  ): Promise<Response> => {
    const url = parseBlossomURL(source);
    if (!url) throw new Error("Invalid Blossom URL");
    const method = init.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("Blossom requests must use GET or HEAD");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    init.signal.throwIfAborted();
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await resolveWithSignal(resolve, hostname, init.signal);
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) =>
        !isIP(address) ||
        (!trusted.has(url.origin) && !isPublicAddress(address))
      )
    ) throw new Error("Blossom destination is not public");
    init.signal.throwIfAborted();

    // Only the validated IP is supplied to the connector. The original hostname
    // remains the TLS verification/SNI name and HTTP Host (including its port).
    const headers = new Headers();
    const range = new Headers(init.headers).get("range");
    if (range) headers.set("range", range);
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");

    return await new Promise<Response>((resolveResponse, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          hostname: addresses[0].address,
          servername: family ? undefined : hostname,
          ca: options.ca,
          method,
          headers: Object.fromEntries(headers),
          signal: init.signal,
          agent: false,
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
            responseHeaders.append(
              incoming.rawHeaders[i],
              incoming.rawHeaders[i + 1],
            );
          }
          const status = incoming.statusCode!;
          const bodyless = method === "HEAD" ||
            [204, 205, 304].includes(status);
          if (bodyless) incoming.resume();
          try {
            resolveResponse(
              new Response(
                bodyless
                  ? null
                  : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
                { status, headers: responseHeaders },
              ),
            );
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      request.on("error", reject);
      request.end();
    });
  };
}
