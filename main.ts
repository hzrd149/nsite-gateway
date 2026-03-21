#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read

import { buildApp } from "./src/server.ts";
import { HOST, NSITE_HOST, NSITE_PORT } from "./src/env.ts";
import { watchInvalidation } from "./src/invalidation.ts";
import pool from "./src/nostr.ts";

const app = buildApp();

console.log(`Starting nsite gateway on http://${HOST}`);

const invalidation = watchInvalidation();

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
  invalidation?.unsubscribe();
  for (const [, relay] of pool.relays) relay.close();
  await server.shutdown();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
