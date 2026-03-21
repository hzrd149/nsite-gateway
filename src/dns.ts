import { nip05 } from "nostr-tools";
import { pubkeyDomains } from "./cache.ts";
import logger from "./logger.ts";
import { parseNsiteHostname } from "./nsite-host.ts";
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

export async function resolvePubkeyFromHostname(
  hostname: string,
): Promise<{ pubkey: string; identifier: string } | undefined> {
  if (hostname === "localhost") return undefined;

  const cached = await pubkeyDomains.get(hostname);
  if (cached) return cached;

  let resolved = parseNsiteHostname(hostname);

  if (!resolved) {
    for (const cname of await getCnameRecords(hostname)) {
      const candidate = parseNsiteHostname(cname);
      if (candidate) {
        resolved = candidate;
        break;
      }
    }
  }

  if (!resolved) {
    for (const txt of await getTxtRecords(hostname)) {
      for (const entry of txt) {
        const candidate = parseNsiteHostname(entry);
        if (candidate) {
          resolved = candidate;
          break;
        }
      }
      if (resolved) break;
    }
  }

  if (!resolved && NIP05_NAME_DOMAINS.length > 0) {
    const [name] = hostname.split(".");
    for (const domain of NIP05_NAME_DOMAINS) {
      try {
        const result = await nip05.queryProfile(`${name}@${domain}`);
        if (result) {
          resolved = { pubkey: result.pubkey, identifier: "" };
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!resolved) {
    log(`Failed to resolve ${hostname}`);
    return undefined;
  }

  log(
    `Resolved ${hostname} to ${resolved.pubkey} with identifier "${resolved.identifier}"`,
  );
  await pubkeyDomains.set(hostname, resolved);

  return resolved;
}
