import { Filter, NostrEvent, SimplePool } from "nostr-tools";
import { getServersFromServerListEvent, USER_BLOSSOM_SERVER_LIST_KIND } from "blossom-client-sdk";

import { LOOKUP_RELAYS } from "./env.js";

const pool = new SimplePool();

export async function getUserOutboxes(pubkey: string) {
  const mailboxes = await pool.get(LOOKUP_RELAYS, { kinds: [10002], authors: [pubkey] });
  if (!mailboxes) return;

  return mailboxes.tags.filter((t) => t[0] === "r" && (t[2] === undefined || t[2] === "write")).map((t) => t[1]);
}

export async function getUserBlossomServers(pubkey: string, relays: string[]) {
  const blossomServersEvent = await pool.get(relays, { kinds: [USER_BLOSSOM_SERVER_LIST_KIND], authors: [pubkey] });

  return blossomServersEvent ? getServersFromServerListEvent(blossomServersEvent).map((u) => u.toString()) : undefined;
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
