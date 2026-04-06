import type { AddressPointer, EventPointer } from "applesauce-core/helpers";

export type ReplaceableSiteAddress = AddressPointer & {
  type: "replaceable";
};

export type SnapshotSiteAddress = EventPointer & {
  type: "snapshot";
};

export type ResolvedSiteAddress = ReplaceableSiteAddress | SnapshotSiteAddress;
