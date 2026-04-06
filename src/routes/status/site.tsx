import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import type { FC, PropsWithChildren } from "@hono/hono/jsx";
import {
  decodePointer,
  naddrEncode,
  neventEncode,
  type NostrEvent,
  npubEncode,
} from "applesauce-core/helpers";
import { decodeHex32B36 } from "../../helpers/base36.ts";
import { formatAgeFromUnix, shortId } from "../../helpers/format.ts";
import {
  formatNsiteSubdomain,
  formatSnapshotSubdomain,
} from "../../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../../helpers/resolved-site.ts";
import { buildIndexedSites, type SiteSnapshotSummary } from "../../helpers/site-index.ts";
import {
  getManifestDescription,
  getManifestPaths,
  getManifestRelays,
  getManifestServers,
  getManifestSource,
  getManifestTitle,
  getSnapshotParentAddress,
  ROOT_SITE_MANIFEST_KIND,
} from "../../helpers/site-manifest.ts";
import { getBlobServer } from "../../services/cache.ts";
import {
  eventStore,
  getManifest,
  getUserBlossomServers,
  getUserProfile,
} from "../../services/nostr.ts";
import { getHitCount } from "../../services/analytics.ts";

type SitePathEntry = {
  path: string;
  sha256: string;
  serverDomain: string | null;
  serverHref: string | null;
};

type LinkedSiteSummary = {
  label: string;
  address: string;
  href?: string;
};

type SnapshotTableEntry = SiteSnapshotSummary & {
  matchesCurrent: boolean;
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

function haveMatchingPaths(a: NostrEvent, b: NostrEvent): boolean {
  const aPaths = getManifestPaths(a);
  const bPaths = getManifestPaths(b);
  if (aPaths.size !== bPaths.size) return false;

  for (const [path, sha256] of aPaths) {
    if (bPaths.get(path) !== sha256) return false;
  }

  return true;
}

function parseNsiteAddress(
  address: string,
): ResolvedSiteAddress | undefined {
  if (/^v[0-9a-z]{50}$/.test(address)) {
    const id = decodeHex32B36(address.slice(1));
    if (id) return { type: "snapshot", id };
  }

  try {
    const result = decodePointer(address);
    if (result.type === "npub") {
      return {
        type: "replaceable",
        pubkey: result.data,
        identifier: "",
        kind: ROOT_SITE_MANIFEST_KIND,
      };
    }
    if (result.type === "naddr") {
      return {
        type: "replaceable",
        pubkey: result.data.pubkey,
        identifier: result.data.identifier,
        kind: result.data.kind,
      };
    }
    if (result.type === "nprofile") {
      return {
        type: "replaceable",
        pubkey: result.data.pubkey,
        identifier: "",
        kind: ROOT_SITE_MANIFEST_KIND,
      };
    }
    if (result.type === "nevent") {
      return {
        type: "snapshot",
        ...result.data,
      };
    }
  } catch {
    // not a nip19 string
  }

  if (/^[0-9a-f]{64}$/i.test(address)) {
    return {
      type: "replaceable",
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
  site: ResolvedSiteAddress,
  host: string,
): string | undefined {
  const subdomain = site.type === "snapshot"
    ? formatSnapshotSubdomain(site.id)
    : formatNsiteSubdomain(site.pubkey, site.identifier);
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
  isSnapshot: boolean;
  host: string;
  protocol: string;
  hostname?: string;
  href?: string;
  rawManifest: string;
  snapshots: SnapshotTableEntry[];
  parentSite?: LinkedSiteSummary;
  authorName?: string;
  authorImage?: string;
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
                  <div style="display:flex;align-items:center;gap:0.75rem;">
                    {props.authorImage && (
                      <img
                        src={props.authorImage}
                        alt=""
                        width="40"
                        height="40"
                        style="border-radius:9999px;object-fit:cover;"
                      />
                    )}
                    <div>
                      <div>{props.authorName || npub}</div>
                      <div class="meta">
                        <span title={props.pubkey}>{npub}</span>
                      </div>
                    </div>
                  </div>
                </InfoRow>
                <InfoRow label="identifier">
                  {props.isSnapshot ? "SNAPSHOT" : props.identifier || "ROOT"}
                </InfoRow>
                {props.parentSite && (
                  <InfoRow label="parent site">
                    <a href={props.parentSite.href ?? `/status/${props.parentSite.address}`}>
                      {props.parentSite.label}
                    </a>
                  </InfoRow>
                )}
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

          {props.snapshots.length > 0 && (
            <section>
              <h2>Snapshots ({props.snapshots.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>snapshot</th>
                    <th>status</th>
                    <th>current</th>
                    <th>paths</th>
                    <th>updated</th>
                  </tr>
                </thead>
                <tbody>
                  {props.snapshots.map((snapshot) => {
                    const snapshotStatusAddress = neventEncode({ id: snapshot.id });
                    const snapshotStatusHref = snapshotStatusAddress
                      ? `/status/${snapshotStatusAddress}`
                      : undefined;
                    const snapshotSubdomain = formatSnapshotSubdomain(snapshot.id);
                    const snapshotHref = snapshotSubdomain
                      ? `${props.protocol}//${snapshotSubdomain}.${props.host}/`
                      : undefined;
                    const label = snapshot.title || shortId(snapshot.id, 12);
                    return (
                      <tr key={snapshot.id}>
                        <td data-label="snapshot">
                          {snapshotHref
                            ? <a href={snapshotHref}>{label}</a>
                            : label}
                        </td>
                        <td data-label="status">
                          {snapshotStatusHref
                            ? <a href={snapshotStatusHref}>status</a>
                            : ""}
                        </td>
                        <td data-label="current">
                          {snapshot.matchesCurrent ? "matches current" : ""}
                        </td>
                        <td data-label="paths">{snapshot.pathCount}</td>
                        <td
                          data-label="updated"
                          title={formatTimestamp(snapshot.createdAt)}
                        >
                          {formatAgeFromUnix(snapshot.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

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
          as an npub, naddr, nevent, nprofile, hex pubkey, or snapshot id.
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
  const manifest = await getManifest(parsed, 5_000);

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

  const identifier = parsed.type === "replaceable" ? parsed.identifier : "";

  const [userServers, hits, profile] = await Promise.all([
    getUserBlossomServers(manifest.pubkey, 5_000),
    getHitCount(manifest.pubkey, identifier),
    getUserProfile(manifest.pubkey, 5_000),
  ]);

  const manifestPaths = getManifestPaths(manifest);
  const manifestServers = getManifestServers(manifest);
  const relays = getManifestRelays(manifest);
  const title = getManifestTitle(manifest);
  const description = getManifestDescription(manifest);
  const source = getManifestSource(manifest);
  const indexedSites = buildIndexedSites(eventStore.getTimeline({}));
  const indexedSite = parsed.type === "replaceable"
    ? indexedSites.find((site) =>
      site.kind === parsed.kind && site.pubkey === parsed.pubkey &&
      site.identifier === parsed.identifier
    )
    : undefined;
  const snapshots: SnapshotTableEntry[] = (indexedSite?.snapshots ?? []).map(
    (snapshot) => {
      const event = eventStore.getTimeline({ kinds: [manifest.kind, 5128] }).find(
        (candidate) => candidate.id === snapshot.id,
      );
      return {
        ...snapshot,
        matchesCurrent: !!event && haveMatchingPaths(manifest, event),
      };
    },
  );
  const parentSite = parsed.type === "snapshot"
    ? (() => {
      const parent = getSnapshotParentAddress(manifest);
      if (!parent) return undefined;

      const address = parent.identifier
        ? naddrEncode({
          pubkey: parent.pubkey,
          identifier: parent.identifier,
          kind: parent.kind,
        })
        : npubEncode(parent.pubkey);
      const label = parent.identifier || npubEncode(parent.pubkey);
      return {
        label,
        address,
        href: `/status/${address}`,
      } satisfies LinkedSiteSummary;
    })()
    : undefined;

  const siteHostname = getSiteHostname(parsed, url.host);

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
          pubkey={manifest.pubkey}
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
          isSnapshot={parsed.type === "snapshot"}
          host={url.host}
          protocol={url.protocol}
          hostname={siteHostname}
          href={siteHostname ? `${url.protocol}//${siteHostname}/` : undefined}
          rawManifest={rawManifest}
          snapshots={snapshots}
          parentSite={parentSite}
          authorName={profile?.display_name || profile?.name}
          authorImage={profile?.picture}
        />
      )}
    `,
    200,
    { "Cache-Control": "no-store" },
  );
}
