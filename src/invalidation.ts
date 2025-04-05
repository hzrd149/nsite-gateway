import { npubEncode } from "nostr-tools/nip19";

import { SUBSCRIPTION_RELAYS } from "./env.js";
import { parseNsiteEvent } from "./events.js";
import pool from "./nostr.js";
import { NSITE_KIND } from "./const.js";
import logger from "./logger.js";
import { pathBlobs } from "./cache.js";

const log = logger.extend("invalidation");

export function watchInvalidation() {
  if (SUBSCRIPTION_RELAYS.length === 0) return;

  logger(`Listening for new nsite events on: ${SUBSCRIPTION_RELAYS.join(", ")}`);

  pool.subscribeMany(SUBSCRIPTION_RELAYS, [{ kinds: [NSITE_KIND], since: Math.round(Date.now() / 1000) - 60 * 60 }], {
    onevent: async (event) => {
      try {
        const parsed = parseNsiteEvent(event);
        if (parsed) {
          pathBlobs.delete(parsed.pubkey + parsed.path);

          log(`Invalidated ${npubEncode(parsed.pubkey) + parsed.path}`);
        }
      } catch (error) {
        console.log(`Failed to invalidate ${event.id}`);
      }
    },
  });
}
