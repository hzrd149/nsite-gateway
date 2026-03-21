import { nip05, nip19 } from "nostr-tools";
import { pubkeyDomains } from "./cache.ts";
import logger from "./logger.ts";
import { NIP05_NAME_DOMAINS } from "./env.ts";

const log = logger.extend("dns");

async function getCnameRecords(hostname: string): Promise<string[]> {
  try {
    return await Deno.resolveDns(hostname, "CNAME");
  } catch {
    return [];
  }
}

async function getTxtRecords(hostname: string): Promise<string[][]> {
  try {
    return await Deno.resolveDns(hostname, "TXT");
  } catch {
    return [];
  }
}

function extractPubkeyFromHostname(hostname: string): string | undefined {
  const parts = hostname.split(".");
  for (const part of parts) {
    if (!part.startsWith("npub")) continue;
    const parsed = nip19.decode(part);
    if (parsed.type !== "npub") throw new Error("Expected npub");
    return parsed.data;
  }
}

function extractIdentifierFromHostname(hostname: string): string {
  const parts = hostname.split(".");
  const npubIndex = parts.findIndex((part) => part.startsWith("npub"));
  if (npubIndex > 0) return parts[0];
  return "";
}

export async function resolvePubkeyFromHostname(
  hostname: string,
): Promise<{ pubkey: string; identifier: string } | undefined> {
  if (hostname === "localhost") return undefined;

  const cached = await pubkeyDomains.get(hostname);
  if (cached) {
    return {
      pubkey: cached,
      identifier: extractIdentifierFromHostname(hostname),
    };
  }

  let pubkey = extractPubkeyFromHostname(hostname);

  if (!pubkey) {
    for (const cname of await getCnameRecords(hostname)) {
      const candidate = extractPubkeyFromHostname(cname);
      if (candidate) {
        pubkey = candidate;
        break;
      }
    }
  }

  if (!pubkey) {
    for (const txt of await getTxtRecords(hostname)) {
      for (const entry of txt) {
        const candidate = extractPubkeyFromHostname(entry);
        if (candidate) {
          pubkey = candidate;
          break;
        }
      }
      if (pubkey) break;
    }
  }

  if (!pubkey && NIP05_NAME_DOMAINS.length > 0) {
    const [name] = hostname.split(".");
    for (const domain of NIP05_NAME_DOMAINS) {
      try {
        const result = await nip05.queryProfile(`${name}@${domain}`);
        if (result) {
          pubkey = result.pubkey;
          break;
        }
      } catch {
        continue;
      }
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
