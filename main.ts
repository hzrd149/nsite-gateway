#!/usr/bin/env -S deno run --unstable-kv --allow-env --allow-net --allow-read --allow-write

import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  CACHE_RELAYS,
  HOST,
  LOOKUP_RELAYS,
  NOSTR_RELAYS,
  NSITE_HOST,
  NSITE_PORT,
} from "./src/env.ts";
import app from "./src/server.ts";
import { onShutdown } from "./src/helpers/shutdown.ts";
import { PollOptionsSymbol } from "applesauce-common/helpers";
import { eventStore, pool } from "./src/services/nostr.ts";
import {
  NAMED_SITE_MANIFEST_KIND,
  ROOT_SITE_MANIFEST_KIND,
} from "./src/helpers/site-manifest.ts";

function formatList(values: string[] | undefined, empty = "none") {
  return values && values.length > 0 ? values.join(", ") : empty;
}

console.log(`Starting nsite gateway on http://${HOST}`);
console.log(`lookup relays: ${formatList(LOOKUP_RELAYS)}`);
console.log(`cache relays: ${formatList(CACHE_RELAYS)}`);
console.log(`nostr relays: ${formatList(NOSTR_RELAYS)}`);
console.log(`blossom servers: ${formatList(BLOSSOM_SERVERS)}`);
console.log(`blossom proxy: ${BLOSSOM_PROXY || "none"}`);

const server = Deno.serve(
  {
    hostname: NSITE_HOST,
    port: NSITE_PORT,
    onListen({ hostname, port }) {
      console.log(`nsite gateway listening on http://${hostname}:${port}`);
    },
  },
  app.fetch,
);

// Hydrate from nostr relays when set
if (NOSTR_RELAYS && NOSTR_RELAYS.length > 0) {
  console.log("Hydrating from nostr relays...", NOSTR_RELAYS);

  let found = 0;
  pool.request(NOSTR_RELAYS, {
    kinds: [ROOT_SITE_MANIFEST_KIND, NAMED_SITE_MANIFEST_KIND],
  }).subscribe({
    next: (event) => {
      const insert = eventStore.add(event);

      // If not null and new event
      if (insert && insert === event) found++;
    },
    complete: () =>
      console.log(`Found ${found} site manifest events from nostr relays`),
  });
}

onShutdown(async () => {
  console.log("nsite gateway shutting down...");
  await server.shutdown();
});
