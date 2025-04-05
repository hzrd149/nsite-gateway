import dns from "node:dns";
import { nip19 } from "nostr-tools";
import { pubkeyDomains as pubkeyDomains } from "./cache.js";
import logger from "./logger.js";

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

  // try to get npub from CNAME or TXT records
  if (!pubkey) {
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

  log(`Resolved ${hostname} to ${pubkey}`);
  await pubkeyDomains.set(hostname, pubkey);

  return pubkey;
}
