import { decodePointer } from "applesauce-core/helpers";
import { decodeHex32B36 } from "./base36.ts";
import {
  formatNsiteSubdomain,
  formatSnapshotSubdomain,
  parseNsiteHostname,
} from "./nsite-host.ts";
import type { ResolvedSiteAddress } from "./resolved-site.ts";
import { ROOT_SITE_MANIFEST_KIND } from "./site-manifest.ts";

function rootSite(pubkey: string): ResolvedSiteAddress {
  return {
    type: "replaceable",
    pubkey,
    identifier: "",
    kind: ROOT_SITE_MANIFEST_KIND,
  };
}

/**
 * Parses a user supplied site address without any network access. Accepts
 * npub, nprofile, naddr, nevent, hex pubkeys, snapshot labels and full nsite
 * URLs or hostnames.
 */
export function parseSiteAddress(
  input: string,
): ResolvedSiteAddress | undefined {
  let address = input.trim();
  if (!address || address.length > 2048) return undefined;

  // Strip a "nostr:" prefix
  if (address.toLowerCase().startsWith("nostr:")) address = address.slice(6);

  // Accept a full nsite URL or bare hostname
  if (/^https?:\/\//i.test(address) || address.includes(".")) {
    try {
      const url = new URL(
        /^https?:\/\//i.test(address) ? address : `https://${address}`,
      );
      return parseNsiteHostname(url.hostname);
    } catch {
      return undefined;
    }
  }

  if (/^v[0-9a-z]{50}$/.test(address)) {
    const id = decodeHex32B36(address.slice(1));
    if (id) return { type: "snapshot", id };
  }

  if (/^[0-9a-f]{64}$/i.test(address)) return rootSite(address.toLowerCase());

  try {
    const result = decodePointer(address);
    switch (result.type) {
      case "npub":
        return rootSite(result.data);
      case "nprofile":
        return rootSite(result.data.pubkey);
      case "naddr":
        return {
          type: "replaceable",
          pubkey: result.data.pubkey,
          identifier: result.data.identifier,
          kind: result.data.kind,
        };
      case "nevent":
        return { type: "snapshot", ...result.data };
    }
  } catch {
    // not a nip19 string
  }

  // Canonical named site label without a domain
  return parseNsiteHostname(address);
}

/** Returns the gateway subdomain label for a parsed site address */
export function getSiteSubdomain(
  site: ResolvedSiteAddress,
): string | undefined {
  return site.type === "snapshot"
    ? formatSnapshotSubdomain(site.id)
    : formatNsiteSubdomain(site.pubkey, site.identifier);
}
