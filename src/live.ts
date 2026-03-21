import { onlyEvents } from "applesauce-relay";
import { npubEncode } from "nostr-tools/nip19";
import { SUBSCRIPTION_RELAYS } from "./env.ts";
import { cacheManifestEvent } from "./events.ts";
import { NSITE_MANIFEST_KIND, NSITE_ROOT_SITE_KIND } from "./const.ts";
import logger from "./logger.ts";
import pool from "./nostr.ts";

const log = logger.extend("invalidation");

export function watchLiveEvents() {
  if (SUBSCRIPTION_RELAYS.length === 0) return undefined;

  log(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

  return pool
    .subscription(SUBSCRIPTION_RELAYS, {
      kinds: [NSITE_ROOT_SITE_KIND, NSITE_MANIFEST_KIND],
      since: Math.round(Date.now() / 1000) - 60 * 60,
    })
    .pipe(onlyEvents())
    .subscribe(async (event) => {
      if (
        event.kind === NSITE_ROOT_SITE_KIND ||
        event.kind === NSITE_MANIFEST_KIND
      ) {
        const parsed = await cacheManifestEvent(event);
        if (!parsed) return;
        const scope = parsed.identifier ? `named:${parsed.identifier}` : "root";
        log(
          `Found new site manifest for ${
            npubEncode(parsed.pubkey)
          } (${scope}) id=${event.id} paths=${parsed.paths.size}`,
        );
      }
    });
}
