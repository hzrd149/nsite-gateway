import logger from "../helpers/debug.ts";
import { parseNsiteHostname } from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { getDNSPubkey, setDNSPubkey } from "./cache.ts";
import { isNamecoinHostname, resolveNamecoinHostname } from "./namecoin.ts";

const log = logger.extend("dns");

type ResolveDns = (
  hostname: string,
  recordType: "CNAME",
) => Promise<string[]>;

type ResolveNamecoin = (
  hostname: string,
) => Promise<ResolvedSiteAddress | undefined>;

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
  resolveNamecoin: ResolveNamecoin = resolveNamecoinHostname,
): Promise<ResolvedSiteAddress | undefined> {
  if (hostname === "localhost" || hostname === "127.0.0.1") return undefined;

  let resolved = parseNsiteHostname(hostname);
  const namecoinHostname = isNamecoinHostname(hostname);

  // Namecoin values and expiry must be re-read, not hidden behind a pointer
  // cache. Other hostname mappings retain the existing bounded DNS cache.
  if (!namecoinHostname) {
    const cached = await getDNSPubkey(hostname);
    if (cached) return cached;
  }

  if (!resolved && namecoinHostname) {
    resolved = await resolveNamecoin(hostname);
    if (!resolved) {
      log(`Failed to resolve Namecoin hostname ${hostname}`);
      return undefined;
    }
  }

  if (!resolved && !namecoinHostname) {
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
      : `Resolved ${hostname} to exact event ${resolved.id}`,
  );
  if (!namecoinHostname) await setDNSPubkey(hostname, resolved);

  return resolved;
}
