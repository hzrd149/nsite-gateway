#!/usr/bin/env -S deno run --unstable-kv --allow-env --allow-net --allow-read --allow-write

import app from "./src/server.ts";
import { closeCache, initCache } from "./src/services/cache.ts";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  CACHE_RELAYS,
  HOST,
  LOOKUP_RELAYS,
  NSITE_HOST,
  NSITE_PORT,
} from "./src/helpers/env.ts";
import pool from "./src/services/nostr.ts";

function formatList(values: string[] | undefined, empty = "none") {
  return values && values.length > 0 ? values.join(", ") : empty;
}

function logStartupStatus() {
  console.log(`Starting nsite gateway on http://${HOST}`);
  console.log(
    "routing=nsite via canonical hostnames or CNAME aliases | local via public folder and app routes",
  );
  console.log(`lookup relays=${formatList(LOOKUP_RELAYS)}`);
  console.log(`cache relays=${formatList(CACHE_RELAYS)}`);
  console.log(`blossom servers=${formatList(BLOSSOM_SERVERS)}`);
  console.log(`blossom proxy=${BLOSSOM_PROXY || "none"}`);
}

await initCache();

logStartupStatus();

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
  for (const [, relay] of pool.relays) relay.close();
  await closeCache();
  await server.shutdown();
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
