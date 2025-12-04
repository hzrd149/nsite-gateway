import dns from "node:dns";
import { nip05, nip19 } from "nostr-tools";
import { pubkeyDomains as pubkeyDomains } from "./cache.js";
import logger from "./logger.js";
import { NIP05_NAME_DOMAINS } from "./env.js";

export function getCnameRecords(hostname: string): Promise<string[]> {
  return new Promise<string[]>((res, rej) => {
    dns.resolveCname(hostname, (err, records) => {
      if (err) rej(err);
      else res(records);
    });
  });
}
export function getTxtRecords(hostname: string): Promise<string[][]> {
  return new Promise<string[][]>((res, rej) => {
    dns.resolveTxt(hostname, (err, records) => {
      if (err) rej(err);
      else res(records);
    });
  });
}

function extractPubkeyFromHostname(hostname: string): string | undefined {
  const parts = hostname.split(".");

  // Check if any part is an npub
  for (const part of parts) {
    if (part.startsWith("npub")) {
      const parsed = nip19.decode(part);
      if (parsed.type !== "npub") throw new Error("Expected npub");
      return parsed.data;
    }
  }
}

/**
 * Extracts the identifier from a hostname
 * Format: [identifier].<npub>.nsite-host.com
 * Returns empty string "" for root site (no identifier subdomain)
 */
function extractIdentifierFromHostname(hostname: string): string {
  const parts = hostname.split(".");

  // Find the npub part
  const npubIndex = parts.findIndex((part) => part.startsWith("npub"));

  // If npub is found and there's a part before it, that's the identifier
  if (npubIndex > 0) {
    return parts[0];
  }

  // Root site (no identifier)
  return "";
}

const log = logger.extend("DNS");

export async function resolvePubkeyFromHostname(
  hostname: string,
): Promise<{ pubkey: string; identifier: string } | undefined> {
  if (hostname === "localhost") return undefined;

  const cached = await pubkeyDomains.get(hostname);
  if (cached) {
    const identifier = extractIdentifierFromHostname(hostname);
    return { pubkey: cached, identifier };
  }

  // check if domain contains an npub
  let pubkey = extractPubkeyFromHostname(hostname);

  if (!pubkey) {
    // try to get npub from CNAME
    try {
      const cnameRecords = await getCnameRecords(hostname);
      for (const cname of cnameRecords) {
        const p = extractPubkeyFromHostname(cname);
        if (p) {
          pubkey = p;
          break;
        }
      }
    } catch (error) {}
  }

  if (!pubkey) {
    // Try to get npub from TXT records
    try {
      const txtRecords = await getTxtRecords(hostname);

      for (const txt of txtRecords) {
        for (const entry of txt) {
          const p = extractPubkeyFromHostname(entry);
          if (p) {
            pubkey = p;
            break;
          }
        }
      }
    } catch (error) {}
  }

  // Try to get npub from NIP-05
  if (!pubkey && NIP05_NAME_DOMAINS) {
    for (const domain of NIP05_NAME_DOMAINS) {
      try {
        const [name] = hostname.split(".");
        const result = await nip05.queryProfile(name + "@" + domain);
        if (result) {
          pubkey = result.pubkey;
          break;
        }
      } catch (err) {}
    }
  }

  if (!pubkey) {
    log(`Failed to resolve ${hostname}`);
    return undefined;
  }

  const identifier = extractIdentifierFromHostname(hostname);
  log(`Resolved ${hostname} to ${pubkey} with identifier "${identifier}"`);
  await pubkeyDomains.set(hostname, pubkey);

  return { pubkey, identifier };
}
