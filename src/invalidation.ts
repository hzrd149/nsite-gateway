import { onlyEvents } from "applesauce-relay";
import { npubEncode } from "nostr-tools/nip19";
import { pathBlobs, pubkeyEvents, siteManifests } from "./cache.ts";
import { SUBSCRIPTION_RELAYS } from "./env.ts";
import { parseManifestEvent, parseNsiteEvent } from "./events.ts";
import {
  NSITE_FILE_KIND,
  NSITE_MANIFEST_KIND,
  NSITE_ROOT_SITE_KIND,
} from "./const.ts";
import logger from "./logger.ts";
import pool from "./nostr.ts";

const log = logger.extend("invalidation");

export function watchInvalidation() {
  if (SUBSCRIPTION_RELAYS.length === 0) return undefined;

  log(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

  return pool
    .subscription(SUBSCRIPTION_RELAYS, {
      kinds: [NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND, NSITE_FILE_KIND],
      since: Math.round(Date.now() / 1000) - 60 * 60,
    })
    .pipe(onlyEvents())
    .subscribe((event) => {
      if (
        event.kind === NSITE_ROOT_SITE_KIND ||
        event.kind === NSITE_MANIFEST_KIND
      ) {
        const parsed = parseManifestEvent(event);
        if (!parsed) return;
        siteManifests.delete(`${parsed.pubkey}:${parsed.identifier}`);
        log(`Invalidated manifest for ${npubEncode(parsed.pubkey)}`);
        return;
      }

      if (event.kind === NSITE_FILE_KIND) {
        const parsed = parseNsiteEvent(event);
        if (!parsed) return;
        pathBlobs.delete(`${parsed.pubkey}::${parsed.path}`);
        pubkeyEvents.delete(parsed.pubkey);
        log(
          `Invalidated legacy file for ${
            npubEncode(parsed.pubkey)
          } (${parsed.path})`,
        );
      }
    });
}
