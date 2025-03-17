import { nip19 } from "nostr-tools";

import { ENABLE_SCREENSHOTS, NGINX_CACHE_DIR, SUBSCRIPTION_RELAYS } from "./env.js";
import { parseNsiteEvent } from "./events.js";
import pool from "./nostr.js";
import { invalidatePubkeyPath } from "./nginx.js";
import { NSITE_KIND } from "./const.js";
import logger from "./logger.js";

export function watchInvalidation() {
  // invalidate nginx cache and screenshots on new events
  if (SUBSCRIPTION_RELAYS.length > 0) {
    logger(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

    pool.subscribeMany(SUBSCRIPTION_RELAYS, [{ kinds: [NSITE_KIND], since: Math.round(Date.now() / 1000) - 60 * 60 }], {
      onevent: async (event) => {
        try {
          const nsite = parseNsiteEvent(event);
          if (nsite) {
            const log = logger.extend(nip19.npubEncode(nsite.pubkey));
            if (NGINX_CACHE_DIR) {
              log(`Invalidating ${nsite.path}`);
              await invalidatePubkeyPath(nsite.pubkey, nsite.path);
            }

            // invalidate screenshot for nsite
            if (ENABLE_SCREENSHOTS && (nsite.path === "/" || nsite.path === "/index.html")) {
              const { removeScreenshot } = await import("./screenshots.js");
              await removeScreenshot(nsite.pubkey);
            }
          }
        } catch (error) {
          console.log(`Failed to invalidate ${event.id}`);
        }
      },
    });
  }
}
