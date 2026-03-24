import type { FC } from "@hono/hono/jsx";
import { formatAgeFromUnix } from "../helpers/format.ts";
import { naddrEncode } from "applesauce-core/helpers";
import { NAMED_SITE_MANIFEST_KIND } from "../helpers/site-manifest.ts";

export type StatusSite = {
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
  authorName?: string;
};

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().replace(".000Z", "Z");
}

const SiteRow: FC<{ site: StatusSite }> = ({ site }) => {
  const label = site.title || site.identifier ||
    site.npub.slice(0, 8) + "..." + site.npub.slice(-4);
  const statusAddress = site.identifier
    ? naddrEncode({
      pubkey: site.pubkey,
      identifier: site.identifier,
      kind: NAMED_SITE_MANIFEST_KIND,
    })
    : site.npub;
  const statusHref = `/status/${statusAddress}`;
  return (
    <tr>
      <td data-label="site">
        {site.href ? <a href={site.href}>{label}</a> : label}
      </td>
      <td data-label="author">
        <span title={site.pubkey}>{site.authorName || site.npub}</span>
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

export const StatusPage: FC<{ sites: StatusSite[]; host: string }> = (
  { sites, host },
) => {
  const generatedAt = new Date().toISOString().replace(".000Z", "Z");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Gateway status</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="wide">
          <header>
            <h1>Known cached sites</h1>
            <a href="/">&larr; back to gateway</a>
            <p class="meta">
              {pluralize(sites.length, "cached site", "cached sites")} on {host}
              {" "}
              | generated {generatedAt}
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
              {sites.length === 0
                ? (
                  <tr>
                    <td colspan={5}>No cached sites yet.</td>
                  </tr>
                )
                : (
                  sites.map((site) => <SiteRow key={site.key} site={site} />)
                )}
            </tbody>
          </table>
        </main>
      </body>
    </html>
  );
};
