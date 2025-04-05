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
  const [npub] = hostname.split(".");

  if (npub.startsWith("npub")) {
    const parsed = nip19.decode(npub);
    if (parsed.type !== "npub") throw new Error("Expected npub");

    return parsed.data;
  }
}

const log = logger.extend("DNS");

export async function resolvePubkeyFromHostname(hostname: string): Promise<string | undefined> {
  if (hostname === "localhost") return undefined;

  const cached = await pubkeyDomains.get(hostname);
  if (cached) return cached;

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

  log(`Resolved ${hostname} to ${pubkey}`);
  await pubkeyDomains.set(hostname, pubkey);

  return pubkey;
}
