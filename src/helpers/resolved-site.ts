import type { AddressPointer, EventPointer } from "applesauce-core/helpers";

export type ReplaceableSiteAddress = AddressPointer & {
  type: "replaceable";
};

export type SnapshotSiteAddress = EventPointer & {
  type: "snapshot";
};

/** An exact manifest event selected by a NIP-19 event pointer. */
export type EventSiteAddress = EventPointer & {
  type: "event";
};

export type ResolvedSiteAddress =
  | ReplaceableSiteAddress
  | SnapshotSiteAddress
  | EventSiteAddress;
