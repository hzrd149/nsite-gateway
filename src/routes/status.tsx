import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { BLOSSOM_SERVER_LIST_KIND } from "applesauce-common/helpers";
import {
  getSeenRelays,
  naddrEncode,
  neventEncode,
  type NostrEvent,
  npubEncode,
} from "applesauce-core/helpers";
import { BLOSSOM_SERVERS } from "../env.ts";
import { getBlossomServers } from "../helpers/blossom.ts";
import { getSiteStatusPath, TRENDING_DAYS } from "../helpers/directory.ts";
import { shortenNpub, shortId } from "../helpers/format.ts";
import { formatSnapshotSubdomain } from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { getSiteSubdomain, parseSiteAddress } from "../helpers/site-address.ts";
import {
  getManifestAddressKey,
  getManifestClient,
  getManifestDescription,
  getManifestPaths,
  getManifestRelays,
  getManifestServers,
  getManifestSource,
  getManifestTitle,
  getSnapshotParentAddress,
  isSiteManifestKind,
  MANIFEST_SNAPSHOT_KIND,
} from "../helpers/site-manifest.ts";
import { getNsiteDeployClientReference } from "../nsite-clients.ts";
import { getGatewayContext, siteHref } from "../pages/gateway/components.tsx";
import {
  type SiteStatusData,
  SiteStatusPage,
  SiteUnknownPage,
  type StatusPath,
} from "../pages/gateway/status.tsx";
import { getHitCount } from "../services/analytics.ts";
import { getBadBlobSource } from "../services/cache.ts";
import { getDirectory } from "../services/directory.ts";
import { eventStore, getLastRelaySync } from "../services/nostr.ts";
import { getServeLog } from "../services/site-telemetry.ts";

/** Max failing paths checked for bad-source marks (bounds KV reads) */
const MAX_BAD_SOURCE_PATHS = 10;

const STATUS_HEADERS = {
  "Cache-Control": "public, max-age=60",
  "X-Robots-Tag": "noindex, nofollow",
};

/** Looks up a manifest from memory only. Never touches the network. */
function getCachedManifest(
  site: ResolvedSiteAddress,
): NostrEvent | undefined {
  const event = site.type === "snapshot"
    ? eventStore.getEvent(site.id)
    : eventStore.getReplaceable(site.kind, site.pubkey, site.identifier);
  return event && isSiteManifestKind(event.kind) ? event : undefined;
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

export async function siteStatusRoute(c: Context): Promise<Response> {
  const address = c.req.param("address") ?? "";
  const gateway = getGatewayContext(c.req.url);
  const parsed = parseSiteAddress(address);
  const manifest = parsed && getCachedManifest(parsed);

  if (!parsed || !manifest) {
    const siteUrl = parsed && siteHref(gateway, getSiteSubdomain(parsed));
    return c.html(
      html`<!DOCTYPE html>${(
        <SiteUnknownPage
          gateway={gateway}
          address={address.slice(0, 200)}
          parsed={parsed}
          siteUrl={siteUrl}
        />
      )}`,
      parsed ? 404 : 400,
      STATUS_HEADERS,
    );
  }

  const isSnapshot = manifest.kind === MANIFEST_SNAPSHOT_KIND;
  const parent = isSnapshot ? getSnapshotParentAddress(manifest) : undefined;
  // Analytics and serve logs are keyed by the address the visitor used
  const pubkey = manifest.pubkey;
  const identifier = parsed.type === "replaceable" ? parsed.identifier : "";
  const directory = getDirectory();
  const author = directory.authors.get(pubkey);
  const npub = npubEncode(pubkey);

  const manifestServers = getManifestServers(manifest);
  const userServerList = eventStore.getReplaceable(
    BLOSSOM_SERVER_LIST_KIND,
    pubkey,
  );
  const userServers = userServerList &&
    getBlossomServers(userServerList.tags);

  const [serveLog, allTime] = await Promise.all([
    getServeLog(parsed),
    isSnapshot ? Promise.resolve(0) : getHitCount(pubkey, identifier),
  ]);

  const manifestPaths = getManifestPaths(manifest);
  const paths: StatusPath[] = [...manifestPaths.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha256]) => ({
      path,
      sha256,
      record: serveLog[path],
      badSources: [],
    }))
    // Failing paths first, then recently served, then the rest by path
    .sort((a, b) => {
      const rank = (p: StatusPath) =>
        !p.record ? 2 : p.record.r === "served" ? 1 : 0;
      return rank(a) - rank(b) || (b.record?.t ?? 0) - (a.record?.t ?? 0);
    });

  // Look up bad-source marks only for failing paths
  const candidates = [
    ...new Set([
      ...manifestServers,
      ...(userServers ?? []),
      ...BLOSSOM_SERVERS,
    ]),
  ];
  await Promise.all(
    paths
      .filter((p) => p.record && p.record.r === "unavailable")
      .slice(0, MAX_BAD_SOURCE_PATHS)
      .map(async (p) => {
        for (const server of candidates) {
          let url: string;
          try {
            url = new URL(p.sha256, server).toString();
          } catch {
            continue;
          }
          const bad = await getBadBlobSource(pubkey, p.sha256, url);
          if (bad) {
            p.badSources.push({
              host: new URL(url).host,
              reason: bad.reason,
              expiresAt: bad.expiresAt,
            });
          }
        }
      }),
  );

  const missing = Object.entries(serveLog)
    .filter(([path]) => !manifestPaths.has(path))
    .map(([path, record]) => ({ path, record }))
    .sort((a, b) => b.record.t - a.record.t)
    .slice(0, 50);

  // Snapshots of this site that are in memory
  const indexed = isSnapshot ? undefined : directory.sites.get(
    getManifestAddressKey({ kind: manifest.kind, pubkey, identifier }),
  );
  const snapshotEvents = isSnapshot ? [] : eventStore
    .getTimeline({ kinds: [MANIFEST_SNAPSHOT_KIND], authors: [pubkey] })
    .filter((event) => {
      const p = getSnapshotParentAddress(event);
      return p && p.kind === manifest.kind && p.identifier === identifier;
    })
    .sort((a, b) => b.created_at - a.created_at);

  const title = getManifestTitle(manifest);
  const siteUrl = siteHref(gateway, getSiteSubdomain(parsed));
  const label = title || indexed?.label ||
    (isSnapshot ? `snapshot ${shortId(manifest.id, 12)}` : undefined) ||
    identifier || author?.label || shortenNpub(npub);

  const data: SiteStatusData = {
    gateway,
    address,
    kind: manifest.kind,
    isSnapshot,
    identifier,
    label,
    title,
    description: getManifestDescription(manifest),
    siteUrl,
    source: getManifestSource(manifest),
    client: getNsiteDeployClientReference(getManifestClient(manifest)),
    createdAt: manifest.created_at,
    eventId: manifest.id,
    author: {
      pubkey,
      npub,
      label: author?.label ?? shortenNpub(npub),
      listed: !!author,
    },
    parent: parent
      ? {
        label: parent.identifier || shortenNpub(npubEncode(parent.pubkey)),
        statusPath: parent.identifier
          ? `/status/${naddrEncode(parent)}`
          : getSiteStatusPath(parent.pubkey, ""),
      }
      : undefined,
    seenRelays: [...(getSeenRelays(manifest) ?? [])],
    manifestRelays: getManifestRelays(manifest),
    lastRelaySync: getLastRelaySync(),
    manifestServers,
    userServers,
    fallbackServers: BLOSSOM_SERVERS,
    hits: {
      allTime,
      daily: indexed?.dailyHits ?? new Array(TRENDING_DAYS).fill(0),
    },
    paths,
    missing,
    snapshots: snapshotEvents.map((event) => {
      const subdomain = formatSnapshotSubdomain(event.id);
      return {
        id: event.id,
        label: getManifestTitle(event) || shortId(event.id, 12),
        pathCount: getManifestPaths(event).size,
        createdAt: event.created_at,
        href: siteHref(gateway, subdomain),
        statusPath: `/status/${neventEncode({ id: event.id })}`,
        matchesCurrent: haveMatchingPaths(manifest, event),
      };
    }),
    raw: JSON.stringify(
      {
        id: manifest.id,
        pubkey: manifest.pubkey,
        created_at: manifest.created_at,
        kind: manifest.kind,
        tags: manifest.tags,
        content: manifest.content,
        sig: manifest.sig,
      },
      null,
      2,
    ),
  };

  return c.html(
    html`<!DOCTYPE html>${<SiteStatusPage data={data} />}`,
    200,
    STATUS_HEADERS,
  );
}
