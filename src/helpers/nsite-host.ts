import { decodePointer, npubEncode } from "applesauce-core/helpers";
import { decodeHex32B36, encodeHex32B36 } from "./base36.ts";
import type { ResolvedSiteAddress } from "./resolved-site.ts";
import {
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "./site-manifest.ts";

const CANONICAL_PUBKEY_LENGTH = 50;

export const CANONICAL_SITE_IDENTIFIER = /^(?=.{1,13}$)[a-z0-9-]*[a-z0-9]$/;

function decodeNpub(npub: string): string | undefined {
  try {
    const parsed = decodePointer(npub);
    return parsed.type === "npub" ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function decodePubkeyB36(pubkeyB36: string): string | undefined {
  return decodeHex32B36(pubkeyB36);
}

export function encodePubkeyB36(pubkey: string): string | undefined {
  return encodeHex32B36(pubkey);
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
): ResolvedSiteAddress | undefined {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  const label = parts[0];
  if (!label) return undefined;

  const rootPubkey = decodeNpub(label);
  if (rootPubkey) {
    return {
      type: "replaceable",
      pubkey: rootPubkey,
      identifier: "",
      kind: ROOT_SITE_MANIFEST_KIND,
    };
  }

  if (/^v[0-9a-z]{50}$/.test(label)) {
    const id = decodeHex32B36(label.slice(1));
    if (id) return { type: "snapshot", id };
  }

  const canonical = parseCanonicalSiteLabel(label);
  if (canonical) {
    return {
      type: "replaceable",
      ...canonical,
      kind: NAMED_SITE_MANIFEST_KIND,
    };
  }

  return undefined;
}

export function formatSnapshotSubdomain(eventId: string): string | undefined {
  const eventIdB36 = encodeHex32B36(eventId);
  if (!eventIdB36) return undefined;
  return `v${eventIdB36}`;
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
