import { onlyEvents } from "applesauce-relay";
import { npubEncode } from "nostr-tools/nip19";
import { NSITE_MANIFEST_KIND, NSITE_ROOT_SITE_KIND } from "./helpers/const.ts";
import { SUBSCRIPTION_RELAYS } from "./helpers/env.ts";
import logger from "./helpers/debug.ts";
import { logDiscoveredManifest } from "./helpers/manifest-log.ts";
import { cacheManifestEvent } from "./helpers/events.ts";
import { siteManifests } from "./services/cache.ts";
import pool from "./services/nostr.ts";

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
        const identifier = event.kind === NSITE_ROOT_SITE_KIND
          ? ""
          : event.tags.find((tag) => tag[0] === "d" && tag[1] !== undefined)
            ?.[1];
        if (!identifier && event.kind !== NSITE_ROOT_SITE_KIND) return;

        const siteKey = `${event.pubkey}:${identifier}`;
        const cached = await siteManifests.get(siteKey);
        const parsed = await cacheManifestEvent(event);
        if (!parsed) return;
        const scope = parsed.identifier ? `named:${parsed.identifier}` : "root";
        if (cached?.id !== event.id) {
          logDiscoveredManifest(event);
        }
        log(
          `Found new site manifest for ${
            npubEncode(parsed.pubkey)
          } (${scope}) id=${event.id} paths=${parsed.paths.size}`,
        );
      }
    });
}
