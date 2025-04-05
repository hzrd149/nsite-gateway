import { Filter, NostrEvent, SimplePool } from "nostr-tools";
import { getServersFromServerListEvent, USER_BLOSSOM_SERVER_LIST_KIND } from "blossom-client-sdk";

import { LOOKUP_RELAYS } from "./env.js";
import { pubkeyRelays, pubkeyServers } from "./cache.js";
import logger from "./logger.js";
import { npubEncode } from "nostr-tools/nip19";

const pool = new SimplePool();

const log = logger.extend("nostr");

/** Fetches a pubkeys mailboxes from the cache or relays */
export async function getUserOutboxes(pubkey: string) {
  const cached = await pubkeyRelays.get(pubkey);
  if (cached) return cached;
  const mailboxes = await pool.get(LOOKUP_RELAYS, { kinds: [10002], authors: [pubkey] });

  if (!mailboxes) return;

  const relays = mailboxes.tags
    .filter((t) => t[0] === "r" && (t[2] === undefined || t[2] === "write"))
    .map((t) => t[1]);

  log(`Found ${relays.length} relays for ${npubEncode(pubkey)}`);
  await pubkeyRelays.set(pubkey, relays);

  await pubkeyRelays.set(pubkey, relays);
  return relays;
}

/** Fetches a pubkeys blossom servers from the cache or relays */
export async function getUserBlossomServers(pubkey: string, relays: string[]) {
  const cached = await pubkeyServers.get(pubkey);
  if (cached) return cached;

  const blossomServersEvent = await pool.get(relays, { kinds: [USER_BLOSSOM_SERVER_LIST_KIND], authors: [pubkey] });
  const servers = blossomServersEvent
    ? getServersFromServerListEvent(blossomServersEvent).map((u) => u.toString())
    : undefined;

  // Save servers if found
  if (servers) {
    log(`Found ${servers.length} blossom servers for ${npubEncode(pubkey)}`);
    await pubkeyServers.set(pubkey, servers);
  }

  return servers;
}

export function requestEvents(relays: string[], filter: Filter) {
  return new Promise<NostrEvent[]>(async (res, rej) => {
    const events: NostrEvent[] = [];

    await Promise.allSettled(relays.map((url) => pool.ensureRelay(url).catch((e) => {})));

    const sub = pool.subscribeMany(relays, [filter], {
      onevent: (e) => events.push(e),
      oneose: () => sub.close(),
      onclose: (reasons) => {
        const errs = reasons.filter((r) => r !== "closed by caller");
        if (errs.length > 0 && events.length === 0) rej(new Error(errs.join(", ")));
        else res(events);
      },
    });
  });
}

export default pool;
