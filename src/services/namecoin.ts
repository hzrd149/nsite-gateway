import logger from "../helpers/debug.ts";
import { decodeNsitePointer } from "../helpers/nip19.ts";
import { CANONICAL_SITE_IDENTIFIER } from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import {
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import {
  type NamecoinValueFetcher,
  resolveNamecoinNode,
} from "./namecoin-import.ts";

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
  let normalized = hostname.trim().toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  // Routing and validation are deliberately separate. Every .bit suffix is
  // handled by Namecoin, including malformed names, so DNS is never a fallback.
  return normalized.endsWith(".bit") && normalized.length > 4;
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
  /** Host labels left of the Namecoin name, in DNS presentation order. */
  subdomains: string[];
}

function normalizeNamecoinHostname(
  hostname: string,
): { hostname: string; labels: string[] } | undefined {
  if (typeof hostname !== "string") return undefined;
  let normalized = hostname.trim().toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (
    !normalized.endsWith(".bit") || normalized.length <= 4 ||
    normalized.length > 253
  ) {
    return undefined;
  }

  const labels = normalized.slice(0, -4).split(".");
  if (
    labels.some((label) =>
      label.length === 0 || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    return undefined;
  }
  const registrable = labels[labels.length - 1];
  if (
    !/^(?:xn--)?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(registrable) ||
    /^[0-9]+$/.test(registrable)
  ) {
    return undefined;
  }
  return { hostname: normalized, labels };
}

/** Parse a `.bit` hostname into its Namecoin lookup key. */
export function parseNamecoinHostname(
  hostname: string,
): NamecoinHostname | undefined {
  const normalized = normalizeNamecoinHostname(hostname);
  if (!normalized) return undefined;
  const labels = normalized.labels;
  const registrable = labels[labels.length - 1];
  return {
    hostname: normalized.hostname,
    namecoinName: `d/${registrable}`,
    subdomains: labels.slice(0, -1),
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

function isLowerHexPubkey(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function isLowerHexEventId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function decodeNpubToHex(value: string): string | undefined {
  try {
    const parsed = decodeNsitePointer(value);
    return parsed.type === "npub" && isLowerHexPubkey(parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

function relayFields(relays: unknown): { relays?: string[] } {
  if (!Array.isArray(relays)) return {};
  const valid = relays.filter((relay): relay is string => {
    if (typeof relay !== "string") return false;
    try {
      const url = new URL(relay);
      return url.protocol === "ws:" || url.protocol === "wss:";
    } catch {
      return false;
    }
  });
  return valid.length > 0 ? { relays: valid } : {};
}

type LegacyIdentity = {
  pubkey: string;
  relays?: string[];
};

type LegacyIdentitySelection =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "selected"; identity: LegacyIdentity };

const ABSENT_IDENTITY: LegacyIdentitySelection = { status: "absent" };
const INVALID_IDENTITY: LegacyIdentitySelection = { status: "invalid" };

function selectNostrIdentity(
  obj: Record<string, unknown>,
): LegacyIdentitySelection {
  if (!hasOwn(obj, "nostr")) return ABSENT_IDENTITY;

  const nostr = obj.nostr;
  if (typeof nostr === "string") {
    return isHexPubkey(nostr)
      ? { status: "selected", identity: { pubkey: nostr.toLowerCase() } }
      : INVALID_IDENTITY;
  }
  if (!isRecord(nostr)) return INVALID_IDENTITY;

  // A names field is authoritative when present. In particular, an invalid
  // root entry or an ambiguous map must not fall through to another identity.
  if (hasOwn(nostr, "names")) {
    const names = nostr.names;
    if (!isRecord(names)) return INVALID_IDENTITY;

    let selected: unknown;
    if (hasOwn(names, "_")) {
      selected = names._;
    } else {
      const entries = Object.values(names);
      if (entries.length !== 1) return INVALID_IDENTITY;
      selected = entries[0];
    }

    if (!isHexPubkey(selected)) return INVALID_IDENTITY;
    const pubkey = selected.toLowerCase();
    const relays = isRecord(nostr.relays) ? nostr.relays[pubkey] : undefined;
    return {
      status: "selected",
      identity: { pubkey, ...relayFields(relays) },
    };
  }

  if (hasOwn(nostr, "pubkey")) {
    if (!isHexPubkey(nostr.pubkey)) return INVALID_IDENTITY;
    return {
      status: "selected",
      identity: {
        pubkey: nostr.pubkey.toLowerCase(),
        ...relayFields(nostr.relays),
      },
    };
  }

  return ABSENT_IDENTITY;
}

function selectLegacyIdentity(
  obj: Record<string, unknown>,
): LegacyIdentitySelection {
  const nested = selectNostrIdentity(obj);
  if (nested.status !== "absent") return nested;

  // Top-level author aliases are compatibility inputs only. They are consulted
  // after the nostr identity forms and never override a configured identity.
  if (hasOwn(obj, "pubkey")) {
    return isHexPubkey(obj.pubkey)
      ? {
        status: "selected",
        identity: { pubkey: obj.pubkey.toLowerCase() },
      }
      : INVALID_IDENTITY;
  }
  if (hasOwn(obj, "npub")) {
    const pubkey = typeof obj.npub === "string"
      ? decodeNpubToHex(obj.npub)
      : undefined;
    return pubkey
      ? { status: "selected", identity: { pubkey } }
      : INVALID_IDENTITY;
  }

  return ABSENT_IDENTITY;
}

/**
 * Extract a hex pubkey from a parsed Namecoin name value.
 *
 * Supports the legacy identity forms and their compatibility aliases:
 *
 *  1. `{ "pubkey": "<hex>" }` — direct pubkey at the top level.
 *  2. `{ "npub": "npub1..." }` — npub at the top level.
 *  3. `{ "nostr": "<hex>" }` — simple NIP-05 form.
 *  4. `{ "nostr": { "names": { "_": "<hex>", ... } } }` — extended NIP-05
 *     form. The `_` entry wins. Without it, exactly one entry is required.
 *
 * Returns the lowercase hex pubkey or `undefined`.
 */
export function extractPubkeyFromNamecoinValue(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const selected = selectLegacyIdentity(value);
  return selected.status === "selected" ? selected.identity.pubkey : undefined;
}

type SelectedNsiteField = { present: false } | {
  present: true;
  value: unknown;
};

function getSelectedNsiteField(
  obj: Record<string, unknown>,
): SelectedNsiteField {
  if (isRecord(obj.nostr) && hasOwn(obj.nostr, "nsite")) {
    return { present: true, value: obj.nostr.nsite };
  }
  if (hasOwn(obj, "nsite")) {
    return { present: true, value: obj.nsite };
  }
  return { present: false };
}

function isNip19Like(value: string): boolean {
  return /^(?:npub|nprofile|naddr|nevent|note|nsec|ncryptsec)1/i.test(value);
}

/**
 * Extract an optional nsite identifier hint from a Namecoin name value.
 *
 * If the operator uses the legacy bare named-site shorthand rather than a
 * NIP-19 pointer, they can include either:
 *
 *  - `{ "nsite": "<identifier>" }`
 *  - `{ "nostr": { "nsite": "<identifier>" } }`
 *
 * The nested field takes exclusive precedence. Invalid values and NIP-19
 * pointers return `undefined` here; full target parsing happens in the resolver.
 */
export function extractNsiteIdentifier(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const selected = getSelectedNsiteField(value);
  if (!selected.present || typeof selected.value !== "string") return undefined;
  return !isNip19Like(selected.value) &&
      CANONICAL_SITE_IDENTIFIER.test(selected.value)
    ? selected.value
    : undefined;
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
 * Namecoin mappings are re-read for each request. This makes value changes,
 * expiry, and newly malformed targets visible instead of retaining an old
 * pointer in the ordinary DNS cache.
 */
export async function resolveNamecoinHostname(
  hostname: string,
): Promise<ResolvedSiteAddress | undefined> {
  const parsed = parseNamecoinHostname(hostname);
  if (!parsed) return undefined;

  const servers = getConfiguredServers();
  let rawValue: string | undefined;
  let selectedServer: string | undefined;

  for (const server of servers) {
    log(`Querying ${server} for ${parsed.namecoinName}`);
    try {
      rawValue = await queryNamecoinName(
        server,
        parsed.namecoinName,
        QUERY_TIMEOUT_MS,
      );
      if (rawValue) {
        selectedServer = server;
        break;
      }
    } catch (err) {
      log(`Namecoin lookup via ${server} failed: ${err}`);
    }
  }

  if (!rawValue) {
    log(`Failed to fetch Namecoin value for ${parsed.namecoinName}`);
    return undefined;
  }

  // Some Namecoin records delegate shared blocks into a sibling name via
  // an `import` key (ifa-0001 §"import"). The canonical demo target
  // testls.bit uses this pattern: the apex `d/testls` carries an
  // `import` of `dd/testls`, which actually holds the `nostr.names`
  // block. We expand any such chain before extracting the pubkey, using
  // the same ElectrumX server list for the imported names.
  // Keep one trusted server view for the root and all imported names. Server
  // fallback is used only while selecting the root transport.
  const fetcher: NamecoinValueFetcher = (name) =>
    selectedServer
      ? queryNamecoinName(selectedServer, name, QUERY_TIMEOUT_MS)
      : Promise.resolve(undefined);
  const resolved = await resolveFromNamecoinValueAsync(
    rawValue,
    fetcher,
    parsed.subdomains,
  );
  if (!resolved) {
    log(
      `Namecoin value for ${parsed.namecoinName} did not contain a valid nsite mapping`,
    );
    return undefined;
  }

  return resolved;
}

/**
 * Resolve a raw Namecoin name value (JSON string) into a
 * `ResolvedSiteAddress`. Exposed for testing and for callers that already
 * have the value in hand.
 *
 * Note: this synchronous path does not follow `import` chains. Use
 * `resolveFromNamecoinValueAsync` (or `resolveNamecoinHostname`) when you
 * need import-chain support.
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

  return resolveFromParsedValue(parsed);
}

function resolveFromParsedValue(
  parsed: unknown,
): ResolvedSiteAddress | undefined {
  if (!isRecord(parsed)) return undefined;

  const nsite = getSelectedNsiteField(parsed);
  if (nsite.present) {
    if (typeof nsite.value !== "string") return undefined;

    try {
      const pointer = decodeNsitePointer(nsite.value);

      if (pointer.type === "npub") {
        if (!isLowerHexPubkey(pointer.data)) return undefined;
        return {
          type: "replaceable",
          pubkey: pointer.data,
          identifier: "",
          kind: ROOT_SITE_MANIFEST_KIND,
        };
      }

      if (pointer.type === "nprofile") {
        if (!isLowerHexPubkey(pointer.data.pubkey)) return undefined;
        return {
          type: "replaceable",
          pubkey: pointer.data.pubkey,
          identifier: "",
          kind: ROOT_SITE_MANIFEST_KIND,
          ...relayFields(pointer.data.relays),
        };
      }

      if (pointer.type === "naddr") {
        if (!isLowerHexPubkey(pointer.data.pubkey)) return undefined;
        const isRoot = pointer.data.kind === ROOT_SITE_MANIFEST_KIND &&
          pointer.data.identifier === "";
        const isNamed = pointer.data.kind === NAMED_SITE_MANIFEST_KIND &&
          CANONICAL_SITE_IDENTIFIER.test(pointer.data.identifier);
        if (!isRoot && !isNamed) {
          return undefined;
        }
        return {
          type: "replaceable",
          pubkey: pointer.data.pubkey,
          identifier: pointer.data.identifier,
          kind: pointer.data.kind,
          ...relayFields(pointer.data.relays),
        };
      }

      if (pointer.type === "nevent") {
        if (
          !isLowerHexEventId(pointer.data.id) ||
          (pointer.data.author !== undefined &&
            !isLowerHexPubkey(pointer.data.author)) ||
          (pointer.data.kind !== undefined &&
            pointer.data.kind !== ROOT_SITE_MANIFEST_KIND &&
            pointer.data.kind !== NAMED_SITE_MANIFEST_KIND &&
            pointer.data.kind !== MANIFEST_SNAPSHOT_KIND)
        ) {
          return undefined;
        }
        return {
          type: "event",
          id: pointer.data.id,
          ...(pointer.data.author === undefined
            ? {}
            : { author: pointer.data.author }),
          ...(pointer.data.kind === undefined
            ? {}
            : { kind: pointer.data.kind }),
          ...relayFields(pointer.data.relays),
        };
      }

      if (pointer.type === "note") {
        if (!isLowerHexEventId(pointer.data)) return undefined;
        return { type: "event", id: pointer.data };
      }

      // Other NIP-19 entities are not nsite pointers.
      return undefined;
    } catch {
      // A value that looks like a NIP-19 entity cannot be reinterpreted as
      // legacy shorthand after decoding fails.
      if (isNip19Like(nsite.value)) return undefined;
    }

    if (!CANONICAL_SITE_IDENTIFIER.test(nsite.value)) return undefined;

    const selected = selectLegacyIdentity(parsed);
    if (selected.status !== "selected") return undefined;
    return {
      type: "replaceable",
      ...selected.identity,
      kind: NAMED_SITE_MANIFEST_KIND,
      identifier: nsite.value,
    };
  }

  const selected = selectLegacyIdentity(parsed);
  if (selected.status !== "selected") return undefined;
  return {
    type: "replaceable",
    ...selected.identity,
    identifier: "",
    kind: ROOT_SITE_MANIFEST_KIND,
  };
}

/**
 * Resolve a raw Namecoin name value (JSON string) into a
 * `ResolvedSiteAddress`, following any `import` chain on the value per
 * ifa-0001 §"import". Imported names are fetched via the supplied `fetcher`.
 * Import failures, cycles, and excessive recursion reject the resolution.
 */
export async function resolveFromNamecoinValueAsync(
  rawValue: string,
  fetcher: NamecoinValueFetcher,
  subdomains: string[] = [],
): Promise<ResolvedSiteAddress | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  if (!hasOwn(parsed, "import") && subdomains.length === 0) {
    return resolveFromParsedValue(parsed);
  }

  try {
    const selected = await resolveNamecoinNode(
      parsed,
      subdomains,
      fetcher,
    );
    return resolveFromParsedValue(selected);
  } catch (error) {
    // Retain ifa-0001 recovery only for an unrelated failed import beside a
    // locally pinned nested direct target. A top-level alias is excluded
    // because an imported nested nostr.nsite would take precedence over it.
    if (
      subdomains.length === 0 && isRecord(parsed.nostr) &&
      hasOwn(parsed.nostr, "nsite") &&
      typeof parsed.nostr.nsite === "string"
    ) {
      try {
        decodeNsitePointer(parsed.nostr.nsite);
        const pinned = resolveFromParsedValue(parsed);
        if (pinned) return pinned;
      } catch {
        // Malformed and bare shorthand values never bypass import errors.
      }
    }
    throw error;
  }
}
