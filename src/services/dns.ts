import logger from "../helpers/debug.ts";
import { parseNsiteHostname } from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { getDNSPubkey, setDNSPubkey } from "./cache.ts";

const log = logger.extend("dns");

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
): Promise<ResolvedSiteAddress | undefined> {
  if (hostname === "localhost" || hostname === "127.0.0.1") return undefined;

  const cached = await getDNSPubkey(hostname);
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
    resolved.type === "replaceable"
      ? `Resolved ${hostname} to ${resolved.pubkey} with identifier "${resolved.identifier}"`
      : `Resolved ${hostname} to snapshot ${resolved.id}`,
  );
  await setDNSPubkey(hostname, resolved);

  return resolved;
}
