import type { NostrEvent } from "nostr-tools";
import { formatAgeFromUnix } from "./format.ts";

export type ManifestLogDetails = {
  id: string;
  type: "root" | "named";
  identifier: string;
  pubkey: string;
  age: string;
};

export function getManifestLogDetails(
  event: NostrEvent,
): ManifestLogDetails | undefined {
  let identifier = "";

  if (event.kind !== 15128) {
    const dTag = event.tags.find((tag) =>
      tag[0] === "d" && tag[1] !== undefined
    )
      ?.[1];
    if (!dTag) return undefined;
    identifier = dTag;
  }

  return {
    id: event.id,
    type: identifier === "" ? "root" : "named",
    identifier: identifier || "root",
    pubkey: event.pubkey,
    age: formatAgeFromUnix(event.created_at),
  };
}

export function logDiscoveredManifest(event: NostrEvent): void {
  const details = getManifestLogDetails(event);
  if (!details) return;

  console.log(
    `[manifest] discovered id=${details.id} type=${details.type} identifier=${details.identifier} pubkey=${details.pubkey} age=${details.age}`,
  );
}
