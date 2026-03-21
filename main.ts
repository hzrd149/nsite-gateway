#!/usr/bin/env -S deno run --unstable-kv --allow-env --allow-net --allow-read --allow-write

import { nip19 } from "nostr-tools";
import { closeCache, initCache } from "./src/cache.ts";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  CACHE_RELAYS,
  HOST,
  LOOKUP_RELAYS,
  NSITE_HOMEPAGE,
  NSITE_HOMEPAGE_DIR,
  NSITE_HOST,
  NSITE_PORT,
  PUBLIC_DOMAIN,
  SUBSCRIPTION_RELAYS,
} from "./src/env.ts";
import { watchLiveEvents } from "./src/live.ts";
import pool from "./src/nostr.ts";
import { buildApp } from "./src/server.ts";

function formatList(values: string[] | undefined, empty = "none") {
  return values && values.length > 0 ? values.join(", ") : empty;
}

function describeHomepage() {
  const parts = [
    `homepage ref=${NSITE_HOMEPAGE}`,
    `static dir=${NSITE_HOMEPAGE_DIR}`,
    `public domain=${PUBLIC_DOMAIN || "any unresolved host"}`,
  ];

  try {
    const parsed = nip19.decode(NSITE_HOMEPAGE);
    if (parsed.type === "npub") parts.push(`homepage pubkey=${parsed.data}`);
    if (parsed.type === "nprofile") {
      parts.push(`homepage pubkey=${parsed.data.pubkey}`);
    }
  } catch {
    parts.push("homepage pubkey=unresolved");
  }

  return parts.join(" | ");
}

function logStartupStatus() {
  console.log(`Starting nsite gateway on http://${HOST}`);
  console.log(describeHomepage());
  console.log(`lookup relays=${formatList(LOOKUP_RELAYS)}`);
  console.log(`subscription relays=${formatList(SUBSCRIPTION_RELAYS)}`);
  console.log(`cache relays=${formatList(CACHE_RELAYS)}`);
  console.log(`blossom servers=${formatList(BLOSSOM_SERVERS)}`);
  console.log(`blossom proxy=${BLOSSOM_PROXY || "none"}`);
}

await initCache();

const app = buildApp();

logStartupStatus();

const liveEvents = watchLiveEvents();

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

async function shutdown() {
  console.log("Shutting down...");
  liveEvents?.unsubscribe();
  for (const [, relay] of pool.relays) relay.close();
  await closeCache();
  await server.shutdown();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
