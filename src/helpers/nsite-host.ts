import {
  type AddressPointer,
  decodePointer,
  npubEncode,
} from "applesauce-core/helpers";
import {
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "./site-manifest.ts";

const CANONICAL_PUBKEY_LENGTH = 50;
const MAX_PUBKEY = (1n << 256n) - 1n;

export const CANONICAL_SITE_IDENTIFIER = /^(?=.{1,13}$)[a-z0-9-]*[a-z0-9]$/;

function decodeNpub(npub: string): string | undefined {
  try {
    const parsed = decodePointer(npub);
    return parsed.type === "npub" ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function base36Digit(char: string): bigint | undefined {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return BigInt(code - 48);
  if (code >= 97 && code <= 122) return BigInt(code - 87);
  return undefined;
}

export function decodePubkeyB36(pubkeyB36: string): string | undefined {
  if (!/^[0-9a-z]{50}$/.test(pubkeyB36)) return undefined;

  let value = 0n;
  for (const char of pubkeyB36) {
    const digit = base36Digit(char);
    if (digit === undefined) return undefined;
    value = value * 36n + digit;
    if (value > MAX_PUBKEY) return undefined;
  }

  return value.toString(16).padStart(64, "0");
}

export function encodePubkeyB36(pubkey: string): string | undefined {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return undefined;

  const value = BigInt(`0x${pubkey}`);
  if (value > MAX_PUBKEY) return undefined;
  return value.toString(36).padStart(CANONICAL_PUBKEY_LENGTH, "0");
}

function parseCanonicalSiteLabel(label: string) {
  if (!/^[0-9a-z]{50}[a-z0-9-]{1,13}$/.test(label) || label.endsWith("-")) {
    return undefined;
  }

  const pubkey = decodePubkeyB36(label.slice(0, CANONICAL_PUBKEY_LENGTH));
  const identifier = label.slice(CANONICAL_PUBKEY_LENGTH);
  if (!pubkey || !CANONICAL_SITE_IDENTIFIER.test(identifier)) return undefined;

  return { pubkey, identifier };
}

export function parseNsiteHostname(
  hostname: string,
): AddressPointer | undefined {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  const label = parts[0];
  if (!label) return undefined;

  const rootPubkey = decodeNpub(label);
  if (rootPubkey) {
    return {
      pubkey: rootPubkey,
      identifier: "",
      kind: ROOT_SITE_MANIFEST_KIND,
    };
  }

  const canonical = parseCanonicalSiteLabel(label);
  if (canonical) return { ...canonical, kind: NAMED_SITE_MANIFEST_KIND };

  return undefined;
}

export function formatNsiteSubdomain(
  pubkey: string,
  identifier = "",
): string | undefined {
  const npub = npubEncode(pubkey);
  if (!identifier) return npub;

  if (CANONICAL_SITE_IDENTIFIER.test(identifier)) {
    const pubkeyB36 = encodePubkeyB36(pubkey);
    if (pubkeyB36) return `${pubkeyB36}${identifier}`;
  }

  return undefined;
}
