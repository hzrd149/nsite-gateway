import { decodePointer } from "applesauce-core/helpers";
import logger from "../helpers/debug.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import {
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import { getDNSPubkey, setDNSPubkey } from "./cache.ts";

const log = logger.extend("namecoin");

/**
 * Default ElectrumX server endpoints maintained by the Namecoin ecosystem.
 *
 * Mirrors the Kotlin/Swift/Go/Rust reference implementations. WSS ports are
 * the standard ElectrumX "TCP+TLS+2" convention.
 *
 * Operators currently serve self-signed TLS certificates; operators that
 * want to override this list should set `NSITE_NAMECOIN_ELECTRUMX_SERVERS`
 * to a comma-separated list of `wss://host:port` URLs.
 */
export const DEFAULT_ELECTRUMX_WSS_SERVERS: ReadonlyArray<string> = Object
  .freeze([
    "wss://nmc2.bitcoins.sk:57004",
    "wss://electrumx.testls.space:50004",
  ]);

function getConfiguredServers(): string[] {
  const raw = Deno.env.get("NSITE_NAMECOIN_ELECTRUMX_SERVERS");
  if (!raw) return [...DEFAULT_ELECTRUMX_WSS_SERVERS];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Reports whether a hostname should be routed through Namecoin resolution.
 *
 * Case-insensitive `.bit` suffix check; tolerates a trailing dot.
 */
export function isNamecoinHostname(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  let trimmed = hostname.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith(".")) trimmed = trimmed.slice(0, -1);
  return trimmed.endsWith(".bit") && trimmed.length > 4;
}

/**
 * A parsed Namecoin hostname ready to be queried against the chain.
 *
 * For an nsite gateway we only deal with the `d/` (domain) namespace; the
 * full NIP-05 over Namecoin spec also supports `id/` and `user@domain.bit`
 * shapes but those don't make sense as hostnames.
 */
export interface NamecoinHostname {
  /** Original hostname (lowercased, trailing dot stripped). */
  hostname: string;
  /** Namecoin name to look up on-chain (always `d/<domain>` here). */
  namecoinName: string;
}

/** Parse a `.bit` hostname into its Namecoin lookup key. */
export function parseNamecoinHostname(
  hostname: string,
): NamecoinHostname | undefined {
  if (!isNamecoinHostname(hostname)) return undefined;
  let normalized = hostname.trim().toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  const domain = normalized.slice(0, -4); // strip ".bit"
  if (!domain) return undefined;
  // For a multi-label hostname like `blog.alice.bit`, the on-chain Namecoin
  // name is the registrable label (`d/alice`). The subdomain part isn't
  // currently used for nsite resolution, so we take the last label before
  // `.bit` as the Namecoin name. This matches how Namecoin DNS works.
  const labels = domain.split(".").filter(Boolean);
  if (labels.length === 0) return undefined;
  const registrable = labels[labels.length - 1];
  if (!registrable) return undefined;
  return {
    hostname: normalized,
    namecoinName: `d/${registrable}`,
  };
}

function isHexPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLower = c >= 97 && c <= 102;
    const isUpper = c >= 65 && c <= 70;
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

function decodeNpubToHex(value: string): string | undefined {
  if (!value.startsWith("npub1")) return undefined;
  try {
    const parsed = decodePointer(value);
    return parsed.type === "npub" ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a hex pubkey from a parsed Namecoin name value.
 *
 * Tolerates four shapes, matching the rust-nostr / NDK reference parsers:
 *
 *  1. `{ "pubkey": "<hex>" }` — direct pubkey at the top level.
 *  2. `{ "npub": "npub1..." }` — npub at the top level.
 *  3. `{ "nostr": "<hex>" }` — simple NIP-05 form.
 *  4. `{ "nostr": { "names": { "_": "<hex>", ... } } }` — extended NIP-05
 *     form. Prefers the `_` root entry, then the first valid pubkey.
 *
 * Returns the lowercase hex pubkey or `undefined`.
 */
export function extractPubkeyFromNamecoinValue(
  value: unknown,
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  // 1. Direct top-level pubkey.
  if (isHexPubkey(obj.pubkey)) return (obj.pubkey as string).toLowerCase();

  // 2. Top-level npub.
  if (typeof obj.npub === "string") {
    const decoded = decodeNpubToHex(obj.npub);
    if (decoded) return decoded;
  }

  // 3 + 4. The `nostr` field.
  const nostrField = obj.nostr;
  if (typeof nostrField === "string") {
    if (isHexPubkey(nostrField)) return nostrField.toLowerCase();
    const decoded = decodeNpubToHex(nostrField);
    if (decoded) return decoded;
    return undefined;
  }
  if (nostrField !== null && typeof nostrField === "object") {
    const nostrObj = nostrField as Record<string, unknown>;

    // 4a. Direct pubkey inside the nostr object.
    if (isHexPubkey(nostrObj.pubkey)) {
      return (nostrObj.pubkey as string).toLowerCase();
    }

    // 4b. `names` map: prefer `_`, then first valid hex pubkey.
    const names = nostrObj.names;
    if (names !== null && typeof names === "object") {
      const namesMap = names as Record<string, unknown>;
      const root = namesMap._;
      if (isHexPubkey(root)) return (root as string).toLowerCase();
      for (const v of Object.values(namesMap)) {
        if (isHexPubkey(v)) return (v as string).toLowerCase();
      }
    }
  }

  return undefined;
}

/**
 * Extract an optional nsite identifier hint from a Namecoin name value.
 *
 * If the operator wants to point a `.bit` name at a named site (kind 35128)
 * rather than the root site (kind 15128), they can include either:
 *
 *  - `{ "nsite": "<identifier>" }`
 *  - `{ "nostr": { "nsite": "<identifier>" } }`
 *
 * If absent, the resolver returns the root site.
 */
export function extractNsiteIdentifier(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.nsite === "string" && obj.nsite.trim()) {
    return obj.nsite.trim();
  }
  const nostrField = obj.nostr;
  if (nostrField !== null && typeof nostrField === "object") {
    const nostrObj = nostrField as Record<string, unknown>;
    if (typeof nostrObj.nsite === "string" && nostrObj.nsite.trim()) {
      return nostrObj.nsite.trim();
    }
  }
  return undefined;
}

/**
 * ElectrumX JSON-RPC over WSS. Opens a single short-lived connection,
 * sends the named method, and races the response or the timeout.
 *
 * Returns the `result` field on success or throws on any error.
 */
function electrumWssCall(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const id = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => {
      finish(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`Namecoin ElectrumX timeout (${url})`));
      });
    }, timeoutMs);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        finish(() => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    };

    ws.onmessage = (event) => {
      finish(() => {
        clearTimeout(timer);
        try {
          const data = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          const parsed = JSON.parse(data);
          if (parsed && parsed.error) {
            reject(
              new Error(
                `Namecoin ElectrumX error: ${
                  typeof parsed.error === "string"
                    ? parsed.error
                    : JSON.stringify(parsed.error)
                }`,
              ),
            );
          } else {
            resolve(parsed?.result);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      });
    };

    ws.onerror = () => {
      finish(() => {
        clearTimeout(timer);
        reject(new Error(`Namecoin ElectrumX socket error (${url})`));
      });
    };

    ws.onclose = () => {
      finish(() => {
        clearTimeout(timer);
        reject(new Error(`Namecoin ElectrumX socket closed (${url})`));
      });
    };
  });
}

/**
 * Query ElectrumX for the latest Namecoin name value via the
 * `blockchain.name.show` method exposed by the Namecoin ElectrumX fork.
 *
 * Some forks expose `blockchain.namecoin.name_show`; we try both before
 * giving up. Returns the raw value string on success.
 */
async function queryNamecoinName(
  serverUrl: string,
  namecoinName: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const methods = ["blockchain.name.show", "blockchain.namecoin.name_show"];
  for (const method of methods) {
    try {
      const result = await electrumWssCall(
        serverUrl,
        method,
        [namecoinName],
        timeoutMs,
      );
      if (!result) continue;
      if (typeof result === "string") return result;
      if (typeof result === "object") {
        const value = (result as Record<string, unknown>).value;
        if (typeof value === "string") return value;
      }
    } catch (err) {
      log(`server ${serverUrl} method ${method} failed: ${err}`);
    }
  }
  return undefined;
}

const QUERY_TIMEOUT_MS = 8000;

/**
 * Resolve a `.bit` hostname to a `ResolvedSiteAddress` via Namecoin.
 *
 * Uses the same cache backing store as the DNS-based resolver so a hit on
 * either path serves the next request from cache.
 */
export async function resolveNamecoinHostname(
  hostname: string,
): Promise<ResolvedSiteAddress | undefined> {
  const parsed = parseNamecoinHostname(hostname);
  if (!parsed) return undefined;

  const cached = await getDNSPubkey(parsed.hostname);
  if (cached) {
    log(`Namecoin cache hit for ${parsed.hostname}`);
    return cached;
  }

  const servers = getConfiguredServers();
  let rawValue: string | undefined;

  for (const server of servers) {
    log(`Querying ${server} for ${parsed.namecoinName}`);
    try {
      rawValue = await queryNamecoinName(
        server,
        parsed.namecoinName,
        QUERY_TIMEOUT_MS,
      );
      if (rawValue) break;
    } catch (err) {
      log(`Namecoin lookup via ${server} failed: ${err}`);
    }
  }

  if (!rawValue) {
    log(`Failed to fetch Namecoin value for ${parsed.namecoinName}`);
    return undefined;
  }

  const resolved = resolveFromNamecoinValue(rawValue);
  if (!resolved) {
    log(
      `Namecoin value for ${parsed.namecoinName} did not contain a usable pubkey`,
    );
    return undefined;
  }

  await setDNSPubkey(parsed.hostname, resolved);
  return resolved;
}

/**
 * Resolve a raw Namecoin name value (JSON string) into a
 * `ResolvedSiteAddress`. Exposed for testing and for callers that already
 * have the value in hand.
 */
export function resolveFromNamecoinValue(
  rawValue: string,
): ResolvedSiteAddress | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return undefined;
  }

  const pubkey = extractPubkeyFromNamecoinValue(parsed);
  if (!pubkey) return undefined;

  const identifier = extractNsiteIdentifier(parsed);
  if (identifier) {
    return {
      type: "replaceable",
      pubkey,
      identifier,
      kind: NAMED_SITE_MANIFEST_KIND,
    };
  }

  return {
    type: "replaceable",
    pubkey,
    identifier: "",
    kind: ROOT_SITE_MANIFEST_KIND,
  };
}
