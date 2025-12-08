import { npubEncode } from "nostr-tools/nip19";

import { SUBSCRIPTION_RELAYS } from "./env.js";
import { parseNsiteEvent, parseManifestEvent } from "./events.js";
import pool from "./nostr.js";
import { NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND, NSITE_FILE_KIND } from "./const.js";
import logger from "./logger.js";
import { pathBlobs, pubkeyEvents, siteManifests } from "./cache.js";
import { onlyEvents } from "applesauce-relay";

const log = logger.extend("invalidation");

export function watchInvalidation() {
  if (SUBSCRIPTION_RELAYS.length === 0) return;

  log(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

  pool
    .subscription(SUBSCRIPTION_RELAYS, {
      kinds: [NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND, NSITE_FILE_KIND],
      since: Math.round(Date.now() / 1000) - 60 * 60,
    })
    .pipe(onlyEvents())
    .subscribe(async (event) => {
      try {
        // Handle site manifest events
        // - Kind 15128: Root site (identifier === "")
        // - Kind 35128: Identifier-specific site (identifier from d tag)
        if (event.kind === NSITE_ROOT_SITE_KIND || event.kind === NSITE_MANIFEST_KIND) {
          const parsed = parseManifestEvent(event);
          if (parsed) {
            // Invalidate the manifest cache
            const manifestKey = `${parsed.pubkey}:${parsed.identifier}`;
            siteManifests.delete(manifestKey);

            // Invalidate all path caches for this pubkey + identifier
            // Note: We can't iterate over all keys easily, so we just clear the manifest
            // and let paths be reloaded on demand

            const siteType = parsed.identifier === "" ? "root site" : `identifier site "${parsed.identifier}"`;
            log(`Invalidated manifest for ${npubEncode(parsed.pubkey)} (${siteType})`);
          }
        }
        // Handle legacy individual file events (kind 34128)
        else if (event.kind === NSITE_FILE_KIND) {
          const parsed = parseNsiteEvent(event);
          if (parsed) {
            // Invalidate the specific path cache (for legacy events, identifier is always "")
            pathBlobs.delete(`${parsed.pubkey}::${parsed.path}`);

            // Invalidate all events for this pubkey so they get reloaded
            pubkeyEvents.delete(parsed.pubkey);

            log(`Invalidated legacy file for ${npubEncode(parsed.pubkey)} (path: ${parsed.path})`);
          }
        }
      } catch (error) {
        console.log(`Failed to invalidate ${event.id}`, error);
      }
    });
}
