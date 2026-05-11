import {
  getMutedThings,
  getPublicMutedThings,
  isHiddenMutesUnlocked,
  unlockHiddenMutes,
} from "applesauce-common/helpers";
import {
  hasHiddenTags,
  kinds,
  type NostrEvent,
  relaySet,
} from "applesauce-core/helpers";
import { lastValueFrom } from "applesauce-core";
import { PrivateKeySigner } from "applesauce-signers/signers";
import { takeUntil, timer } from "rxjs";
import { CURATION_PUBKEY, CURATION_REFRESH } from "../env.ts";
import { CURRATION_NSEC, LOOKUP_RELAYS, NOSTR_RELAYS } from "../env.ts";
import logger from "../helpers/debug.ts";
import { formatAgeFromUnix } from "../helpers/format.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import { eventLoader, eventStore, getUserOutboxes } from "./nostr.ts";

const log = logger.extend("curation");

/** Fetches the curator's mute list (kind 10000) into `eventStore` via `eventLoader`. */
export async function loadCurationMuteList(
  timeout = 5_000,
): Promise<NostrEvent | undefined> {
  if (!CURATION_PUBKEY) return undefined;

  log(`Loading curation mute list`);

  const outboxes = await getUserOutboxes(CURATION_PUBKEY, timeout);
  const relays = relaySet(outboxes, LOOKUP_RELAYS, NOSTR_RELAYS);

  await lastValueFrom(
    eventLoader({
      kind: kinds.Mutelist,
      pubkey: CURATION_PUBKEY,
      relays: relaySet(relays),
      cache: false,
    }).pipe(takeUntil(timer(timeout))),
    { defaultValue: undefined },
  );

  const list = eventStore.getReplaceable(kinds.Mutelist, CURATION_PUBKEY);

  // If there is a list and it has hidden mutes, unlock them using the curator's private key.
  if (
    list && CURRATION_NSEC && hasHiddenTags(list) &&
    isHiddenMutesUnlocked(list) === false
  ) {
    log(`Unlocking hidden mutes`);
    const things = await unlockHiddenMutes(
      list,
      PrivateKeySigner.fromKey(CURRATION_NSEC),
    );

    log(`Unlocked ${things.pubkeys.size} hidden mutes`);
  }

  return list;
}

/** Public `p` tags from the cached curator mute list (no decryption of private mutes). */
export function getCurationMutedPubkeys(): Set<string> {
  if (!CURATION_PUBKEY) return new Set();

  const list = eventStore.getReplaceable(kinds.Mutelist, CURATION_PUBKEY);
  if (!list) return new Set();

  return getMutedThings(list).pubkeys;
}

export function startCurationService(): void {
  if (!CURATION_PUBKEY) return;

  console.log(
    `curation pubkey: ${CURATION_PUBKEY} (mute refresh every ${CURATION_REFRESH}s)`,
  );

  loadCurationMuteList()
    .then((event) => {
      if (!event) {
        console.log("Loaded curator mute list (no event found yet)");
        return;
      }
      console.log(
        `Loaded curator mute list (age ${formatAgeFromUnix(event.created_at)})`,
      );
    })
    .catch((error) => {
      console.error("Failed to load curator mute list", error);
    });

  let muteSyncInFlight = false;
  const muteSyncTimer = setInterval(async () => {
    if (muteSyncInFlight) return;

    muteSyncInFlight = true;

    try {
      await loadCurationMuteList();
      console.log("Refreshed curator mute list");
    } catch (error) {
      console.error("Periodic curator mute list refresh failed", error);
    } finally {
      muteSyncInFlight = false;
    }
  }, CURATION_REFRESH * 1000);

  onShutdown(() => {
    clearInterval(muteSyncTimer);
    return Promise.resolve();
  });
}
