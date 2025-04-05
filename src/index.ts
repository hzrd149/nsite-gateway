#!/usr/bin/env node
import "./polyfill.js";
import Koa from "koa";
import serve from "koa-static";
import path from "node:path";
import cors from "@koa/cors";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import mime from "mime";
import morgan from "koa-morgan";
import { npubEncode } from "nostr-tools/nip19";
import { nip19 } from "nostr-tools";

import { resolvePubkeyFromHostname } from "./dns.js";
import { getNsiteBlob } from "./events.js";
import { streamBlob } from "./blossom.js";
import {
  BLOSSOM_SERVERS,
  HOST,
  NSITE_HOMEPAGE,
  NSITE_HOMEPAGE_DIR,
  NSITE_HOST,
  NSITE_PORT,
  ONION_HOST,
  PUBLIC_DOMAIN,
  SUBSCRIPTION_RELAYS,
} from "./env.js";
import pool, { getUserBlossomServers, getUserOutboxes } from "./nostr.js";
import logger from "./logger.js";
import { watchInvalidation } from "./invalidation.js";
import { NSITE_KIND } from "./const.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = new Koa();

morgan.token("host", (req) => req.headers.host ?? "");

app.use(morgan(":method :host:url :status :response-time ms - :res[content-length]"));

// set CORS headers
app.use(
  cors({
    origin: "*",
    allowMethods: "*",
    allowHeaders: "Authorization,*",
    exposeHeaders: "*",
  }),
);

// handle errors
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.log(err);
    ctx.status = 500;
    if (err instanceof Error) ctx.body = { message: err.message };
  }
});

// handle nsite requests
app.use(async (ctx) => {
  let pubkey = await resolvePubkeyFromHostname(ctx.hostname);

  if (!pubkey && NSITE_HOMEPAGE && (!PUBLIC_DOMAIN || ctx.hostname === PUBLIC_DOMAIN)) {
    const parsed = nip19.decode(NSITE_HOMEPAGE);
    // TODO: use the relays in the nprofile

    if (parsed.type === "nprofile") pubkey = parsed.data.pubkey;
    else if (parsed.type === "npub") pubkey = parsed.data;
  }

  if (!pubkey) {
    ctx.status = 404;
    ctx.body = fs.readFileSync(path.resolve(__dirname, "../public/404.html"), "utf-8");
    return;
  }

  // fetch relays
  const relays = (await getUserOutboxes(pubkey)) || [];

  // always check subscription relays
  relays.push(...SUBSCRIPTION_RELAYS);

  if (relays.length === 0) throw new Error("No relays found");

  // fetch servers and events in parallel
  let [servers, event] = await Promise.all([
    getUserBlossomServers(pubkey, relays).then((s) => s || []),
    getNsiteBlob(pubkey, ctx.path, relays).then((e) => {
      if (!e) return getNsiteBlob(pubkey, "/404.html", relays);
      else return e;
    }),
  ]);

  if (!event) {
    ctx.status = 404;
    ctx.body = `Not Found: no events found\npath: ${ctx.path}\nkind: ${NSITE_KIND}\npubkey: ${pubkey}\nrelays: ${relays.join(", ")}`;
    return;
  }

  // always fetch from additional servers
  servers.push(...BLOSSOM_SERVERS);

  if (servers.length === 0) throw new Error("Failed to find blossom servers");

  try {
    const res = await streamBlob(event.sha256, servers);
    if (!res) {
      ctx.status = 502;
      ctx.body = `Failed to find blob\npath: ${event.path}\nsha256: ${event.sha256}\nservers: ${servers.join(", ")}`;
      return;
    }

    const type = mime.getType(event.path);
    if (type) ctx.set("content-type", type);
    else if (res.headers["content-type"]) ctx.set("content-type", res.headers["content-type"]);

    // pass headers along
    if (res.headers["content-length"]) ctx.set("content-length", res.headers["content-length"]);

    // set Onion-Location header
    if (ONION_HOST) {
      const url = new URL(ONION_HOST);
      url.hostname = npubEncode(pubkey) + "." + url.hostname;
      ctx.set("Onion-Location", url.toString().replace(/\/$/, ""));
    }

    // add cache headers
    ctx.set("ETag", res.headers["etag"] || `"${event.sha256}"`);
    ctx.set("Cache-Control", "public, max-age=3600");
    ctx.set("Last-Modified", res.headers["last-modified"] || new Date(event.created_at * 1000).toUTCString());

    ctx.status = 200;
    ctx.body = res;
    return;
  } catch (error) {
    ctx.status = 500;
    ctx.body = `Failed to stream blob ${event.path}\n${error}`;
    return;
  }
});

if (ONION_HOST) {
  app.use((ctx, next) => {
    // set Onion-Location header if it was not set before
    if (!ctx.get("Onion-Location") && ONION_HOST) {
      ctx.set("Onion-Location", ONION_HOST);
    }

    return next();
  });
}

// serve static files from public
const serveOptions: serve.Options = {
  hidden: true,
  maxAge: 60 * 60 * 1000,
  index: "index.html",
};

try {
  const www = NSITE_HOMEPAGE_DIR;
  fs.statSync(www);
  app.use(serve(www, serveOptions));
} catch (error) {
  const www = path.resolve(__dirname, "../public");
  app.use(serve(www, serveOptions));
}

// start the server
app.listen({ host: NSITE_HOST, port: NSITE_PORT }, () => {
  logger("Started on port", HOST);
});

// watch for invalidations
watchInvalidation();

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function shutdown() {
  logger("Shutting down...");
  pool.destroy();
  process.exit(0);
}

process.addListener("SIGTERM", shutdown);
process.addListener("SIGINT", shutdown);
