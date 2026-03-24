import type { Context } from "@hono/hono";
import type { FC } from "@hono/hono/jsx";
import { html } from "@hono/hono/html";
import { formatAgeFromUnix } from "../../helpers/format.ts";
import { formatNsiteSubdomain } from "../../helpers/nsite-host.ts";
import { getManifestPaths, NAMED_SITE_MANIFEST_KIND, ROOT_SITE_MANIFEST_KIND } from "../../helpers/site-manifest.ts";
import { eventStore } from "../../services/nostr.ts";
import { baseCss } from "./styles.ts";
import { naddrEncode, npubEncode } from "applesauce-core/helpers";

type StatusSite = {
  key: string;
  pubkey: string;
  identifier: string;
  title?: string;
  description?: string;
  pathCount: number;
  manifestId: string;
  createdAt: number;
  hostname?: string;
  href?: string;
  npub: string;
};

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().replace(".000Z", "Z");
}

function getManifestIdentifier(event: { kind: number; tags: string[][] }): string | undefined {
  if (event.kind === ROOT_SITE_MANIFEST_KIND) return "";
  const dTag = event.tags.find((t) => t[0] === "d" && t[1] !== undefined)?.[1];
  return dTag && dTag !== "" ? dTag : undefined;
}

function getStatusSites(host: string, protocol: string): StatusSite[] {
  const manifests = eventStore.getTimeline({
    kinds: [ROOT_SITE_MANIFEST_KIND, NAMED_SITE_MANIFEST_KIND],
  });
  const sites: StatusSite[] = [];

  for (const event of manifests) {
    const identifier = getManifestIdentifier(event);
    if (identifier === undefined) continue;

    const paths = getManifestPaths(event);
    const key = `${event.pubkey}:${identifier}`;
    const subdomain = formatNsiteSubdomain(event.pubkey, identifier);
    const siteHostname = subdomain ? `${subdomain}.${host}` : undefined;
    sites.push({
      key,
      pubkey: event.pubkey,
      identifier,
      title: event.tags.find((t) => t[0] === "title")?.[1],
      description: event.tags.find((t) => t[0] === "description")?.[1],
      pathCount: paths.size,
      manifestId: event.id,
      createdAt: event.created_at,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(event.pubkey),
    });
  }

  return sites.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

const SiteRow: FC<{ site: StatusSite }> = ({ site }) => {
  const label = site.title || site.description || site.hostname || site.npub;
  const statusAddress = site.identifier
    ? naddrEncode({ pubkey: site.pubkey, identifier: site.identifier, kind: NAMED_SITE_MANIFEST_KIND })
    : site.npub;
  const statusHref = `/status/${statusAddress}`;
  return (
    <tr>
      <td data-label="site">{site.href ? <a href={site.href}>{label}</a> : label}</td>
      <td data-label="author">
        <span title={site.pubkey}>{site.npub}</span>
      </td>
      <td data-label="id">{site.identifier || "ROOT"}</td>
      <td data-label="paths">
        <a href={statusHref}>{pluralize(site.pathCount, "path", "paths")}</a>
      </td>
      <td data-label="updated" title={formatTimestamp(site.createdAt)}>
        {formatAgeFromUnix(site.createdAt)}
      </td>
    </tr>
  );
};

const StatusPage: FC<{ sites: StatusSite[]; host: string }> = ({ sites, host }) => {
  const generatedAt = new Date().toISOString().replace(".000Z", "Z");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Gateway status</title>
        <style dangerouslySetInnerHTML={{ __html: baseCss }} />
      </head>
      <body>
        <main>
          <header>
            <h1>Known cached sites</h1>
            <p class="meta">
              {pluralize(sites.length, "cached site", "cached sites")} on {host} | generated {generatedAt}
            </p>
          </header>
          <table>
            <thead>
              <tr>
                <th>site</th>
                <th>author</th>
                <th>id</th>
                <th>paths</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              {sites.length === 0 ? (
                <tr>
                  <td colspan={5}>No cached sites yet.</td>
                </tr>
              ) : (
                sites.map((site) => <SiteRow key={site.key} site={site} />)
              )}
            </tbody>
          </table>
        </main>
      </body>
    </html>
  );
};

export function statusRoute(c: Context): Response | Promise<Response> {
  const url = new URL(c.req.url);
  const sites = getStatusSites(url.host, url.protocol);
  return c.html(html` <!DOCTYPE html>${(<StatusPage sites={sites} host={url.host} />)} `, 200, {
    "Cache-Control": "no-store",
  });
}
