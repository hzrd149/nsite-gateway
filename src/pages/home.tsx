import type { Context } from "@hono/hono";
import type { FC } from "@hono/hono/jsx";
import { html } from "@hono/hono/html";
import { neventEncode, npubEncode } from "applesauce-core/helpers";
import { formatAgeFromUnix } from "../helpers/format.ts";
import {
  formatNsiteSubdomain,
} from "../helpers/nsite-host.ts";
import { buildIndexedSites } from "../helpers/site-index.ts";
import { NAMED_SITE_MANIFEST_KIND } from "../helpers/site-manifest.ts";
import { eventStore, getUserProfile } from "../services/nostr.ts";
import { naddrEncode } from "applesauce-core/helpers";

type HomeSite = {
  key: string;
  pubkey: string;
  identifier: string;
  title?: string;
  description?: string;
  pathCount: number;
  createdAt: number;
  hostname?: string;
  href?: string;
  npub: string;
  authorName?: string;
  snapshotCount: number;
  latestSnapshotId?: string;
  latestSnapshotCreatedAt?: number;
};

async function getHomeSites(
  host: string,
  protocol: string,
): Promise<HomeSite[]> {
  const manifests = buildIndexedSites(eventStore.getTimeline({}));

  const uniquePubkeys = new Set<string>();
  for (const site of manifests) uniquePubkeys.add(site.pubkey);

  const profileEntries = await Promise.all(
    [...uniquePubkeys].map(async (pubkey) =>
      [pubkey, await getUserProfile(pubkey)] as const
    ),
  );
  const profiles = new Map(profileEntries);

  const sites: HomeSite[] = [];

  for (const site of manifests) {
    const subdomain = formatNsiteSubdomain(site.pubkey, site.identifier);
    const siteHostname = subdomain ? `${subdomain}.${host}` : undefined;
    const profile = profiles.get(site.pubkey);
    const latestSnapshot = site.snapshots[0];
    sites.push({
      key: site.key,
      pubkey: site.pubkey,
      identifier: site.identifier,
      title: site.title,
      description: site.description,
      pathCount: site.pathCount,
      createdAt: site.createdAt,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(site.pubkey),
      authorName: profile?.display_name || profile?.name,
      snapshotCount: site.snapshots.length,
      latestSnapshotId: latestSnapshot?.id,
      latestSnapshotCreatedAt: latestSnapshot?.createdAt,
    });
  }

  return sites.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const SiteCard: FC<{ site: HomeSite }> = ({ site }) => {
  const label = site.title || site.hostname || site.npub;
  const statusAddress = site.identifier
    ? naddrEncode({
      pubkey: site.pubkey,
      identifier: site.identifier,
      kind: NAMED_SITE_MANIFEST_KIND,
    })
    : site.npub;
  const statusHref = `/status/${statusAddress}`;
  const snapshotHref = site.latestSnapshotId
    ? `/status/${neventEncode({ id: site.latestSnapshotId })}`
    : undefined;
  return (
    <li class="site-card">
      <div>
        {site.href ? <a href={site.href}>{label}</a> : <span>{label}</span>}
        {site.identifier
          ? <span class="site-meta">&middot; {site.identifier}</span>
          : null}
      </div>
      {site.description
        ? <div class="site-description">{site.description}</div>
        : null}
      <div class="site-meta">
        by {site.authorName || site.npub} &middot;{" "}
        {pluralize(site.pathCount, "page", "pages")} &middot; updated{" "}
        {formatAgeFromUnix(site.createdAt)} ago &middot;{" "}
        {site.snapshotCount > 0
          ? (
            <>
              {pluralize(site.snapshotCount, "snapshot", "snapshots")}
              {site.latestSnapshotCreatedAt
                ? (
                  <>
                    {" "}&middot; latest snapshot {formatAgeFromUnix(site.latestSnapshotCreatedAt)} ago
                  </>
                )
                : null}
              {snapshotHref
                ? <>{" "}&middot; <a href={snapshotHref}>latest snapshot</a></>
                : null}
              {" "}&middot;{" "}
            </>
          )
          : null}
        <a href={statusHref}>status</a>
      </div>
    </li>
  );
};

const HomePage: FC<{ sites: HomeSite[]; host: string }> = ({ sites, host }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>nsite gateway &middot; {host}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="wide">
          <header>
            <h1>nsite gateway</h1>
            <a href="/status">gateway status</a>
            <p class="meta">
              {pluralize(sites.length, "site", "sites")} hosted through {host}
            </p>
          </header>
          {sites.length === 0
            ? (
                <p class="empty-state">
                  No sites cached yet. Sites will appear here as they are made
                  available through this gateway.
                </p>
            )
            : (
              <ul class="site-list">
                {sites.map((site) => <SiteCard key={site.key} site={site} />)}
              </ul>
            )}
        </main>
      </body>
    </html>
  );
};

export async function homeRoute(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const sites = await getHomeSites(url.host, url.protocol);
  return c.html(
    html`
      <!DOCTYPE html>${<HomePage sites={sites} host={url.host} />}
    `,
    200,
    {
      "Cache-Control": "no-store",
    },
  );
}
