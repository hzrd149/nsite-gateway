import { npubEncode } from "nostr-tools/nip19";
import { parseManifestEvent } from "../helpers/events.ts";
import { formatAgeFromUnix } from "../helpers/format.ts";
import { formatNsiteSubdomain } from "../helpers/nsite-host.ts";
import { siteManifests } from "../services/cache.ts";

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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().replace(".000Z", "Z");
}

function getSiteHostname(
  pubkey: string,
  identifier: string,
  host: string,
): string | undefined {
  const subdomain = formatNsiteSubdomain(pubkey, identifier);
  if (!subdomain) return undefined;
  return `${subdomain}.${host}`;
}

async function getStatusSites(
  host: string,
  protocol: string,
): Promise<StatusSite[]> {
  const manifests = await siteManifests.list();
  const sites: StatusSite[] = [];

  for (const { key, value } of manifests) {
    if (!value) continue;
    const parsed = parseManifestEvent(value);
    if (!parsed) continue;

    const siteHostname = getSiteHostname(
      parsed.pubkey,
      parsed.identifier,
      host,
    );
    sites.push({
      key,
      pubkey: parsed.pubkey,
      identifier: parsed.identifier,
      title: parsed.title,
      description: parsed.description,
      pathCount: parsed.paths.size,
      manifestId: value.id,
      createdAt: parsed.created_at,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(parsed.pubkey),
    });
  }

  return sites.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

function renderStatusPage(sites: StatusSite[], host: string): string {
  const generatedAt = new Date().toISOString().replace(".000Z", "Z");
  const rows = sites.length === 0
    ? `<tr><td colspan="5">No cached sites yet.</td></tr>`
    : sites.map((site) => {
      const siteLabel = site.title || site.description || site.hostname ||
        site.npub;
      const siteCell = site.href
        ? `<a href="${escapeHtml(site.href)}">${escapeHtml(siteLabel)}</a>`
        : escapeHtml(siteLabel);
      return `<tr>
  <td data-label="site">${siteCell}</td>
  <td data-label="author"><span title="${escapeHtml(site.pubkey)}">${
        escapeHtml(site.npub)
      }</span></td>
  <td data-label="id">${escapeHtml(site.identifier || "ROOT")}</td>
  <td data-label="paths">${
        escapeHtml(pluralize(site.pathCount, "path", "paths"))
      }</td>
  <td data-label="updated" title="${
        escapeHtml(formatTimestamp(site.createdAt))
      }">${escapeHtml(formatAgeFromUnix(site.createdAt))}</td>
</tr>`;
    }).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Gateway status</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f4ec;
        --fg: #1f2328;
        --muted: #5a6472;
        --line: #d7d1c4;
        --accent: #0f6a5b;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.5 "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
      }

      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }

      h1, p { margin: 0; }

      header {
        margin-bottom: 18px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }

      .meta {
        margin-top: 6px;
        color: var(--muted);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-weight: 600;
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
      }

      @media (max-width: 820px) {
        table, thead, tbody, tr, th, td {
          display: block;
        }

        thead {
          display: none;
        }

        tr {
          padding: 10px 0;
          border-bottom: 1px solid var(--line);
        }

        td {
          padding: 2px 0;
          border: 0;
        }

        td::before {
          content: attr(data-label) " ";
          color: var(--muted);
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Known cached sites</h1>
        <p class="meta">${
    escapeHtml(pluralize(sites.length, "cached site", "cached sites"))
  } on ${escapeHtml(host)} | generated ${escapeHtml(generatedAt)}</p>
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
${rows}
        </tbody>
      </table>
    </main>
  </body>
</html>`;
}

export async function statusRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sites = await getStatusSites(url.host, url.protocol);

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  const body = request.method === "HEAD"
    ? null
    : renderStatusPage(sites, url.host);
  return new Response(body, { status: 200, headers });
}
