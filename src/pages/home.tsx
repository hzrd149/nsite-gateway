import type { Context } from "@hono/hono";
import type { FC } from "@hono/hono/jsx";
import { html } from "@hono/hono/html";
import { formatAgeFromUnix } from "../helpers/format.ts";
import { formatNsiteSubdomain } from "../helpers/nsite-host.ts";
import {
  getManifestPaths,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "../helpers/site-manifest.ts";
import { eventStore, getUserProfile } from "../services/nostr.ts";
import { naddrEncode, npubEncode } from "applesauce-core/helpers";

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
};

function getManifestIdentifier(
  event: { kind: number; tags: string[][] },
): string | undefined {
  if (event.kind === ROOT_SITE_MANIFEST_KIND) return "";
  const dTag = event.tags.find((t) => t[0] === "d" && t[1] !== undefined)?.[1];
  return dTag && dTag !== "" ? dTag : undefined;
}

async function getHomeSites(
  host: string,
  protocol: string,
): Promise<HomeSite[]> {
  const manifests = eventStore.getTimeline({
    kinds: [ROOT_SITE_MANIFEST_KIND, NAMED_SITE_MANIFEST_KIND],
  });

  const uniquePubkeys = new Set<string>();
  for (const event of manifests) uniquePubkeys.add(event.pubkey);

  const profileEntries = await Promise.all(
    [...uniquePubkeys].map(async (pubkey) =>
      [pubkey, await getUserProfile(pubkey)] as const
    ),
  );
  const profiles = new Map(profileEntries);

  const sites: HomeSite[] = [];

  for (const event of manifests) {
    const identifier = getManifestIdentifier(event);
    if (identifier === undefined) continue;

    const paths = getManifestPaths(event);
    const key = `${event.pubkey}:${identifier}`;
    const subdomain = formatNsiteSubdomain(event.pubkey, identifier);
    const siteHostname = subdomain ? `${subdomain}.${host}` : undefined;
    const profile = profiles.get(event.pubkey);
    sites.push({
      key,
      pubkey: event.pubkey,
      identifier,
      title: event.tags.find((t) => t[0] === "title")?.[1],
      description: event.tags.find((t) => t[0] === "description")?.[1],
      pathCount: paths.size,
      createdAt: event.created_at,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(event.pubkey),
      authorName: profile?.display_name || profile?.name,
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
              {pluralize(sites.length, "site", "sites")} hosted on {host}
            </p>
          </header>
          {sites.length === 0
            ? (
              <p class="empty-state">
                No sites cached yet. Sites will appear here as they are visited.
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
