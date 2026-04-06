import type { NostrEvent } from "applesauce-core/helpers";
import {
  getManifestAddressKey,
  getManifestDescription,
  getManifestIdentifier,
  getManifestPaths,
  getManifestTitle,
  getSnapshotParentAddress,
  MANIFEST_SNAPSHOT_KIND,
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "./site-manifest.ts";

export type SiteSnapshotSummary = {
  id: string;
  pubkey: string;
  createdAt: number;
  pathCount: number;
  title?: string;
  description?: string;
};

export type IndexedSite = {
  key: string;
  pubkey: string;
  identifier: string;
  kind: number;
  title?: string;
  description?: string;
  pathCount: number;
  manifestId: string;
  createdAt: number;
  snapshots: SiteSnapshotSummary[];
};

export function buildIndexedSites(events: NostrEvent[]): IndexedSite[] {
  const sites = new Map<string, IndexedSite>();
  const snapshotsByParent = new Map<string, SiteSnapshotSummary[]>();

  for (const event of events) {
    if (event.kind === MANIFEST_SNAPSHOT_KIND) {
      const parent = getSnapshotParentAddress(event);
      if (!parent) continue;

      const key = getManifestAddressKey(parent);
      const snapshots = snapshotsByParent.get(key) ?? [];
      snapshots.push({
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.created_at,
        pathCount: getManifestPaths(event).size,
        title: getManifestTitle(event),
        description: getManifestDescription(event),
      });
      snapshotsByParent.set(key, snapshots);
      continue;
    }

    if (
      event.kind !== ROOT_SITE_MANIFEST_KIND &&
      event.kind !== NAMED_SITE_MANIFEST_KIND
    ) {
      continue;
    }

    const identifier = getManifestIdentifier(event);
    if (identifier === undefined) continue;

    const key = getManifestAddressKey({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: identifier ?? "",
    });
    sites.set(key, {
      key,
      pubkey: event.pubkey,
      identifier: identifier ?? "",
      kind: event.kind,
      title: getManifestTitle(event),
      description: getManifestDescription(event),
      pathCount: getManifestPaths(event).size,
      manifestId: event.id,
      createdAt: event.created_at,
      snapshots: [],
    });
  }

  for (const [key, snapshots] of snapshotsByParent) {
    const site = sites.get(key);
    if (!site) continue;

    snapshots.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return a.id.localeCompare(b.id);
    });
    site.snapshots = snapshots;
  }

  return [...sites.values()].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

export function getIndexedSiteByAddress(
  events: NostrEvent[],
  kind: number,
  pubkey: string,
  identifier: string,
): IndexedSite | undefined {
  const key = getManifestAddressKey({ kind, pubkey, identifier });
  return buildIndexedSites(events).find((site) => site.key === key);
}

export function getSiteIndexEvents(events: NostrEvent[]): NostrEvent[] {
  return events.filter((event) =>
    event.kind === ROOT_SITE_MANIFEST_KIND ||
    event.kind === NAMED_SITE_MANIFEST_KIND ||
    event.kind === MANIFEST_SNAPSHOT_KIND
  );
}
