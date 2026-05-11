import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { formatNsiteSubdomain } from "../../helpers/nsite-host.ts";
import { buildIndexedSites } from "../../helpers/site-index.ts";
import { getCurationMutedPubkeys } from "../../services/curation.ts";
import { eventStore, getUserProfile } from "../../services/nostr.ts";
import { npubEncode } from "applesauce-core/helpers";
import { StatusPage, type StatusSite } from "../../pages/status.tsx";
import { getHitCount } from "../../services/analytics.ts";

function getStatusSites(host: string, protocol: string): StatusSite[] {
  const muted = getCurationMutedPubkeys();
  const manifests = buildIndexedSites(eventStore.getTimeline({})).filter(
    (site) => !muted.has(site.pubkey),
  );
  const sites: StatusSite[] = [];

  for (const site of manifests) {
    const subdomain = formatNsiteSubdomain(site.pubkey, site.identifier);
    const siteHostname = subdomain ? `${subdomain}.${host}` : undefined;
    sites.push({
      key: site.key,
      pubkey: site.pubkey,
      identifier: site.identifier,
      title: site.title,
      description: site.description,
      pathCount: site.pathCount,
      manifestId: site.manifestId,
      createdAt: site.createdAt,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(site.pubkey),
      snapshotCount: site.snapshots.length,
      latestSnapshotId: site.snapshots[0]?.id,
      latestSnapshotCreatedAt: site.snapshots[0]?.createdAt,
    });
  }

  return sites.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

export async function statusRoute(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const sites = getStatusSites(url.host, url.protocol);

  const uniquePubkeys = [...new Set(sites.map((s) => s.pubkey))];
  const profileResults = await Promise.all(
    uniquePubkeys.map(async (pubkey) =>
      [pubkey, await getUserProfile(pubkey, 5_000)] as const
    ),
  );
  const profiles = new Map(profileResults);

  const hitResults = await Promise.all(
    sites.map(async (site) =>
      [site.key, await getHitCount(site.pubkey, site.identifier)] as const
    ),
  );
  const hits = new Map(hitResults);

  for (const site of sites) {
    const profile = profiles.get(site.pubkey);
    if (profile) {
      site.authorName = profile.display_name || profile.name;
    }
    site.hits = hits.get(site.key) ?? 0;
  }

  return c.html(
    html`
      <!DOCTYPE html>${<StatusPage sites={sites} host={url.host} />}
    `,
    200,
    {
      "Cache-Control": "no-store",
    },
  );
}
