import logger from "../helpers/debug.ts";
import { parseNsiteHostname } from "../helpers/nsite-host.ts";
import { pubkeyDomains } from "./cache.ts";

const log = logger.extend("dns");

type ResolvedPubkey = { pubkey: string; identifier: string };
type ResolveDns = (
  hostname: string,
  recordType: "CNAME",
) => Promise<string[]>;

async function getCnameRecords(hostname: string): Promise<string[]> {
  try {
    return await Deno.resolveDns(hostname, "CNAME");
  } catch {
    return [];
  }
}

export async function resolvePubkeyFromHostname(
  hostname: string,
  resolveDns: ResolveDns = getCnameRecords,
): Promise<ResolvedPubkey | undefined> {
  if (hostname === "localhost") return undefined;

  const cached = await pubkeyDomains.get(hostname);
  if (cached) return cached;

  let resolved = parseNsiteHostname(hostname);

  if (!resolved) {
    for (const cname of await resolveDns(hostname, "CNAME")) {
      const candidate = parseNsiteHostname(cname);
      if (candidate) {
        resolved = candidate;
        break;
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
