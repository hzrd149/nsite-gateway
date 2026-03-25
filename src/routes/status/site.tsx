import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import type { FC, PropsWithChildren } from "@hono/hono/jsx";
import {
  decodePointer,
  type NostrEvent,
  npubEncode,
} from "applesauce-core/helpers";
import { formatAgeFromUnix, shortId } from "../../helpers/format.ts";
import { formatNsiteSubdomain } from "../../helpers/nsite-host.ts";
import {
  getManifestDescription,
  getManifestPaths,
  getManifestRelays,
  getManifestServers,
  getManifestSource,
  getManifestTitle,
  ROOT_SITE_MANIFEST_KIND,
} from "../../helpers/site-manifest.ts";
import { getBlobServer } from "../../services/cache.ts";
import { getManifest, getUserBlossomServers } from "../../services/nostr.ts";
import { getHitCount } from "../../services/analytics.ts";

type SitePathEntry = {
  path: string;
  sha256: string;
  serverDomain: string | null;
  serverHref: string | null;
};

function extractServerOrigin(
  url: string,
): { domain: string; href: string } | undefined {
  try {
    const parsed = new URL(url);
    return { domain: parsed.hostname, href: parsed.origin };
  } catch {
    return undefined;
  }
}

function parseNsiteAddress(
  address: string,
): { pubkey: string; identifier: string; kind: number } | undefined {
  try {
    const result = decodePointer(address);
    if (result.type === "npub") {
      return {
        pubkey: result.data,
        identifier: "",
        kind: ROOT_SITE_MANIFEST_KIND,
      };
    }
    if (result.type === "naddr") {
      return {
        pubkey: result.data.pubkey,
        identifier: result.data.identifier,
        kind: result.data.kind,
      };
    }
    if (result.type === "nprofile") {
      return {
        pubkey: result.data.pubkey,
        identifier: "",
        kind: ROOT_SITE_MANIFEST_KIND,
      };
    }
  } catch {
    // not a nip19 string
  }

  if (/^[0-9a-f]{64}$/i.test(address)) {
    return {
      pubkey: address.toLowerCase(),
      identifier: "",
      kind: ROOT_SITE_MANIFEST_KIND,
    };
  }

  return undefined;
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

const InfoRow: FC<PropsWithChildren<{ label: string }>> = (
  { label, children },
) => (
  <tr>
    <td class="info-label">{label}</td>
    <td>{children}</td>
  </tr>
);

const SiteDetailPage: FC<{
  address: string;
  pubkey: string;
  identifier: string;
  title?: string;
  description?: string;
  source?: string;
  manifestServers: string[];
  userServers: string[];
  relays: string[];
  paths: SitePathEntry[];
  hits: number;
  createdAt: number;
  hostname?: string;
  href?: string;
  rawManifest: string;
}> = (props) => {
  const npub = npubEncode(props.pubkey);
  const generatedAt = new Date().toISOString().replace(".000Z", "Z");

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title || props.hostname || npub} — site status</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="wide">
          <header>
            <h1>
              {props.href
                ? (
                  <a href={props.href}>
                    {props.title || props.hostname || npub}
                  </a>
                )
                : (
                  props.title || props.hostname || npub
                )}
            </h1>
            <p class="meta">
              <a href="/status">← all sites</a> | generated {generatedAt}
            </p>
          </header>

          <section>
            <h2>Site info</h2>
            <table class="info-table">
              <tbody>
                {props.title && <InfoRow label="title">{props.title}</InfoRow>}
                {props.description && (
                  <InfoRow label="description">{props.description}</InfoRow>
                )}
                <InfoRow label="author">
                  <span title={props.pubkey}>{npub}</span>
                </InfoRow>
                <InfoRow label="identifier">
                  {props.identifier || "ROOT"}
                </InfoRow>
                {props.hostname && (
                  <InfoRow label="hostname">
                    {props.href
                      ? <a href={props.href}>{props.hostname}</a>
                      : props.hostname}
                  </InfoRow>
                )}
                {props.source && (
                  <InfoRow label="source">
                    <a href={props.source}>{props.source}</a>
                  </InfoRow>
                )}
                <InfoRow label="updated">
                  <span title={formatTimestamp(props.createdAt)}>
                    {formatAgeFromUnix(props.createdAt)} ago
                  </span>
                </InfoRow>
                <InfoRow label="paths">{props.paths.length}</InfoRow>
                <InfoRow label="hits">{props.hits}</InfoRow>
              </tbody>
            </table>
          </section>

          <section>
            <h2>Relays</h2>
            {props.relays.length === 0
              ? <p class="empty">No relays listed in manifest.</p>
              : (
                <ul class="server-list">
                  {props.relays.map((r) => {
                    const href = r.replace(/^wss:\/\//, "https://").replace(
                      /^ws:\/\//,
                      "http://",
                    );
                    return (
                      <li key={r}>
                        <a href={href}>{r}</a>
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>

          <section>
            <h2>Blossom servers</h2>
            <h3>Manifest servers</h3>
            {props.manifestServers.length === 0
              ? <p class="empty">None listed.</p>
              : (
                <ul class="server-list">
                  {props.manifestServers.map((s) => (
                    <li key={s}>
                      <a href={s}>{s}</a>
                    </li>
                  ))}
                </ul>
              )}
            <h3>User servers</h3>
            {props.userServers.length === 0
              ? <p class="empty">None listed.</p>
              : (
                <ul class="server-list">
                  {props.userServers.map((s) => (
                    <li key={s}>
                      <a href={s}>{s}</a>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section>
            <h2>Paths ({props.paths.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>path</th>
                  <th>sha256</th>
                  <th>cached server</th>
                </tr>
              </thead>
              <tbody>
                {props.paths.length === 0
                  ? (
                    <tr>
                      <td colspan={3}>No paths in manifest.</td>
                    </tr>
                  )
                  : (
                    props.paths.map((entry) => (
                      <tr key={entry.path}>
                        <td data-label="path">{entry.path}</td>
                        <td data-label="sha256" title={entry.sha256}>
                          {shortId(entry.sha256, 12)}
                        </td>
                        <td data-label="server">
                          {entry.serverDomain
                            ? (
                              <a href={entry.serverHref!}>
                                {entry.serverDomain}
                              </a>
                            )
                            : <span class="none">—</span>}
                        </td>
                      </tr>
                    ))
                  )}
              </tbody>
            </table>
          </section>

          <section>
            <details>
              <summary>
                <h2>Raw manifest event</h2>
              </summary>
              <pre class="raw-json">{props.rawManifest}</pre>
            </details>
          </section>
        </main>
      </body>
    </html>
  );
};

const SiteNotFoundPage: FC<{ address: string }> = ({ address }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Site not found — status</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <main class="wide">
        <header>
          <h1>Site not found</h1>
          <p class="meta">
            <a href="/status">← all sites</a>
          </p>
        </header>
        <p>
          No manifest found for <strong>{address}</strong>.
        </p>
      </main>
    </body>
  </html>
);

const InvalidAddressPage: FC<{ address?: string }> = ({ address }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Invalid address — status</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <main class="wide">
        <header>
          <h1>Invalid address</h1>
          <p class="meta">
            <a href="/status">← all sites</a>
          </p>
        </header>
        <p>
          Could not parse <strong>{address}</strong>{" "}
          as an npub, naddr, nprofile, or hex pubkey.
        </p>
      </main>
    </body>
  </html>
);

export async function siteStatusRoute(c: Context): Promise<Response> {
  const address = c.req.param("address");
  const parsed = address ? parseNsiteAddress(address) : undefined;

  if (!parsed) {
    return c.html(
      html`
        <!DOCTYPE html>${<InvalidAddressPage address={address ?? ""} />}
      `,
      400,
      {
        "Cache-Control": "no-store",
      },
    );
  }

  const url = new URL(c.req.url);
  const { pubkey, identifier, kind } = parsed;

  const [userServers, manifest, hits] = await Promise.all([
    getUserBlossomServers(pubkey, 5_000),
    getManifest({ pubkey, identifier, kind }, 5_000),
    getHitCount(pubkey, identifier),
  ]);

  if (!manifest) {
    return c.html(
      html`
        <!DOCTYPE html>${<SiteNotFoundPage address={address ?? ""} />}
      `,
      404,
      {
        "Cache-Control": "no-store",
      },
    );
  }

  const manifestPaths = getManifestPaths(manifest);
  const manifestServers = getManifestServers(manifest);
  const relays = getManifestRelays(manifest);
  const title = getManifestTitle(manifest);
  const description = getManifestDescription(manifest);
  const source = getManifestSource(manifest);

  const siteHostname = getSiteHostname(pubkey, identifier, url.host);

  const manifestPathList = [...manifestPaths.entries()];
  const pathEntries: SitePathEntry[] = await Promise.all(
    manifestPathList.map(async ([path, sha256]) => {
      const cached = await getBlobServer(sha256);
      const origin = cached ? extractServerOrigin(cached) : undefined;
      return {
        path,
        sha256,
        serverDomain: origin?.domain ?? null,
        serverHref: origin?.href ?? null,
      };
    }),
  );

  pathEntries.sort((a, b) => a.path.localeCompare(b.path));

  const rawManifest = JSON.stringify(
    {
      id: manifest.id,
      pubkey: manifest.pubkey,
      created_at: manifest.created_at,
      kind: manifest.kind,
      tags: manifest.tags,
      content: manifest.content,
      sig: manifest.sig,
    } satisfies NostrEvent,
    null,
    2,
  );

  return c.html(
    html`
      <!DOCTYPE html>${(
        <SiteDetailPage
          address={address ?? ""}
          pubkey={pubkey}
          identifier={identifier}
          title={title}
          description={description}
          source={source}
          manifestServers={manifestServers}
          userServers={userServers ?? []}
          relays={relays}
          paths={pathEntries}
          hits={hits}
          createdAt={manifest.created_at}
          hostname={siteHostname}
          href={siteHostname ? `${url.protocol}//${siteHostname}/` : undefined}
          rawManifest={rawManifest}
        />
      )}
    `,
    200,
    { "Cache-Control": "no-store" },
  );
}
