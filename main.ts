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
import { syncSiteManifests } from "./src/services/nostr.ts";

const RELAY_SYNC_INTERVAL_MS = 10 * 60 * 1000;

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
  syncSiteManifests(NOSTR_RELAYS)
    .then((found) => {
      console.log(`Found ${found} site manifest events from nostr relays`);
    })
    .catch((error) => {
      console.error("Failed to hydrate from nostr relays", error);
    });

  let syncInFlight = false;
  const syncTimer = setInterval(async () => {
    if (syncInFlight) return;

    syncInFlight = true;

    try {
      const found = await syncSiteManifests(NOSTR_RELAYS);
      console.log(
        `Periodic relay sync found ${found} new site manifest events`,
      );
    } catch (error) {
      console.error("Periodic relay sync failed", error);
    } finally {
      syncInFlight = false;
    }
  }, RELAY_SYNC_INTERVAL_MS);

  onShutdown(async () => {
    clearInterval(syncTimer);
  });
}

onShutdown(async () => {
  console.log("nsite gateway shutting down...");
  await server.shutdown();
});
