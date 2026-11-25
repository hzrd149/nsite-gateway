import { naddrEncode, neventEncode, npubEncode } from "applesauce-core/helpers";
import {
  getNsiteDeployClientReference,
  type NsiteDeployClientReference,
} from "../nsite-clients.ts";
import { shortenNpub } from "./format.ts";
import { formatNsiteSubdomain } from "./nsite-host.ts";
import type { IndexedSite } from "./site-index.ts";
import { NAMED_SITE_MANIFEST_KIND } from "./site-manifest.ts";

/** Number of days used for "trending" rankings */
export const TRENDING_DAYS = 7;

export type DirectoryProfile = { name?: string };

export type DirectorySite = {
  key: string;
  /** Key used by the analytics service: `${pubkey}:${identifier}` */
  hitsKey: string;
  kind: number;
  pubkey: string;
  npub: string;
  identifier: string;
  label: string;
  title?: string;
  description?: string;
  client?: NsiteDeployClientReference;
  pathCount: number;
  createdAt: number;
  /** Newest of manifest and latest snapshot */
  updatedAt: number;
  snapshotCount: number;
  latestSnapshotStatus?: string;
  /** Subdomain label on this gateway, if the site is addressable */
  subdomain?: string;
  /** Path of the status page, e.g. /status/naddr1… */
  statusPath: string;
  authorName?: string;
  /** Total visits over the trending window */
  recentHits: number;
  /** Daily visits over the trending window, oldest first */
  dailyHits: number[];
  /** Lowercased title, identifier and label for search */
  searchName: string;
  /** Lowercased description and author name for search */
  searchExtra: string;
};

export type DirectoryAuthor = {
  pubkey: string;
  npub: string;
  name?: string;
  label: string;
  siteKeys: string[];
  snapshotCount: number;
  recentHits: number;
  latestUpdate: number;
  /** Lowercased name for search */
  searchName: string;
};

export type DirectoryStats = {
  sites: number;
  authors: number;
  snapshots: number;
  clients: number;
};

export type Directory = {
  version: number;
  builtAt: number;
  sites: Map<string, DirectorySite>;
  recent: DirectorySite[];
  trending: DirectorySite[];
  byName: DirectorySite[];
  authors: Map<string, DirectoryAuthor>;
  featuredAuthors: DirectoryAuthor[];
  stats: DirectoryStats;
};

export type DirectoryInput = {
  version: number;
  now: number;
  sites: IndexedSite[];
  muted?: Set<string>;
  /** Daily hit counts per hitsKey, oldest first, TRENDING_DAYS long */
  dailyHits?: Map<string, number[]>;
  profiles?: Map<string, DirectoryProfile>;
  featuredAuthorLimit?: number;
};

export function getHitsKey(pubkey: string, identifier: string): string {
  return `${pubkey}:${identifier}`;
}

export function getSiteStatusPath(pubkey: string, identifier: string): string {
  return `/status/${
    identifier
      ? naddrEncode({ pubkey, identifier, kind: NAMED_SITE_MANIFEST_KIND })
      : npubEncode(pubkey)
  }`;
}

function byUpdated(a: DirectorySite, b: DirectorySite): number {
  return b.updatedAt - a.updatedAt || a.key.localeCompare(b.key);
}

/** Builds an immutable directory snapshot from indexed sites. Pure. */
export function buildDirectory(input: DirectoryInput): Directory {
  const muted = input.muted ?? new Set<string>();
  const sites = new Map<string, DirectorySite>();
  const authors = new Map<string, DirectoryAuthor>();
  const clients = new Set<string>();
  let snapshots = 0;

  for (const site of input.sites) {
    if (muted.has(site.pubkey)) continue;

    const npub = npubEncode(site.pubkey);
    const profile = input.profiles?.get(site.pubkey);
    const hitsKey = getHitsKey(site.pubkey, site.identifier);
    const dailyHits = input.dailyHits?.get(hitsKey) ??
      new Array(TRENDING_DAYS).fill(0);
    const latestSnapshot = site.snapshots[0];
    const client = getNsiteDeployClientReference(site.client);
    if (client) clients.add(client.name);
    snapshots += site.snapshots.length;

    const entry: DirectorySite = {
      key: site.key,
      hitsKey,
      kind: site.kind,
      pubkey: site.pubkey,
      npub,
      identifier: site.identifier,
      label: site.title || site.identifier || profile?.name ||
        shortenNpub(npub),
      title: site.title,
      description: site.description,
      client,
      pathCount: site.pathCount,
      createdAt: site.createdAt,
      updatedAt: Math.max(site.createdAt, latestSnapshot?.createdAt ?? 0),
      snapshotCount: site.snapshots.length,
      latestSnapshotStatus: latestSnapshot
        ? `/status/${neventEncode({ id: latestSnapshot.id })}`
        : undefined,
      subdomain: formatNsiteSubdomain(site.pubkey, site.identifier),
      statusPath: getSiteStatusPath(site.pubkey, site.identifier),
      authorName: profile?.name,
      recentHits: dailyHits.reduce((sum, n) => sum + n, 0),
      dailyHits,
      searchName: "",
      searchExtra: "",
    };
    entry.searchName = [site.title, site.identifier, entry.label]
      .filter(Boolean).join(" ").toLowerCase();
    entry.searchExtra = [site.description, profile?.name]
      .filter(Boolean).join(" ").toLowerCase().slice(0, 500);
    sites.set(entry.key, entry);

    let author = authors.get(site.pubkey);
    if (!author) {
      author = {
        pubkey: site.pubkey,
        npub,
        name: profile?.name,
        label: profile?.name || shortenNpub(npub),
        siteKeys: [],
        snapshotCount: 0,
        recentHits: 0,
        latestUpdate: 0,
        searchName: (profile?.name ?? "").toLowerCase(),
      };
      authors.set(site.pubkey, author);
    }
    author.siteKeys.push(entry.key);
    author.snapshotCount += entry.snapshotCount;
    author.recentHits += entry.recentHits;
    author.latestUpdate = Math.max(author.latestUpdate, entry.updatedAt);
  }

  const all = [...sites.values()];
  const recent = [...all].sort(byUpdated);
  const trending = all
    .filter((site) => site.recentHits > 0)
    .sort((a, b) => b.recentHits - a.recentHits || byUpdated(a, b));
  const byName = [...all].sort((a, b) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
    a.key.localeCompare(b.key)
  );

  for (const author of authors.values()) {
    author.siteKeys.sort((a, b) => byUpdated(sites.get(a)!, sites.get(b)!));
  }

  const featuredAuthors = [...authors.values()]
    .sort((a, b) =>
      b.recentHits - a.recentHits ||
      b.siteKeys.length - a.siteKeys.length ||
      b.latestUpdate - a.latestUpdate ||
      a.pubkey.localeCompare(b.pubkey)
    )
    .slice(0, input.featuredAuthorLimit ?? 8);

  return {
    version: input.version,
    builtAt: input.now,
    sites,
    recent,
    trending,
    byName,
    authors,
    featuredAuthors,
    stats: {
      sites: sites.size,
      authors: authors.size,
      snapshots,
      clients: clients.size,
    },
  };
}
