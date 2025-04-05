import { nip19 } from "nostr-tools";

import { SUBSCRIPTION_RELAYS } from "./env.js";
import { parseNsiteEvent } from "./events.js";
import pool from "./nostr.js";
import { NSITE_KIND } from "./const.js";
import logger from "./logger.js";

export function watchInvalidation() {
  // invalidate nginx cache on new events
  if (SUBSCRIPTION_RELAYS.length > 0) {
    logger(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

    pool.subscribeMany(SUBSCRIPTION_RELAYS, [{ kinds: [NSITE_KIND], since: Math.round(Date.now() / 1000) - 60 * 60 }], {
      onevent: async (event) => {
        try {
          const nsite = parseNsiteEvent(event);
          if (nsite) {
            const log = logger.extend(nip19.npubEncode(nsite.pubkey));
          }
        } catch (error) {
          console.log(`Failed to invalidate ${event.id}`);
        }
      },
    });
  }
}
