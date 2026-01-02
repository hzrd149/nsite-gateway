#!/usr/bin/env node
import cors from "@koa/cors";
import Koa from "koa";
import compress from "koa-compress";
import morgan from "koa-morgan";
import range from "koa-range";
import serve from "koa-static";
import mime from "mime";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nip19 } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import "./polyfill.js";

import { streamBlob } from "./blossom.js";
import { resolvePubkeyFromHostname } from "./dns.js";
import {
  BLOSSOM_PROXY,
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
import { getNsiteBlob } from "./events.js";
import { watchInvalidation } from "./invalidation.js";
import pool, { getUserBlossomServers, getUserOutboxes } from "./nostr.js";
import { mergeBlossomServers } from "applesauce-core/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = new Koa();

morgan.token("host", (req) => req.headers.host ?? "");

app.use(morgan(":method :host:url :status :response-time ms - :res[content-length]"));

// add range request support
app.use(range);

// add compression support
app.use(
  compress({
    filter(contentType) {
      // Don't compress if it's already compressed
      if (/gzip|deflate|br|compress/.test(contentType)) {
        return false;
      }
      // Compress text-based content types
      // Binary files (images, videos, etc.) won't match and won't be compressed
      // Range requests for binary files are safe since they won't be compressed
      return /text|javascript|json|xml|svg|css|html|application\/json|application\/javascript|application\/xml/.test(
        contentType,
      );
    },
    threshold: 1024, // Only compress if response is > 1KB
  }),
);

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
app.use(async (ctx, next) => {
  let resolved = await resolvePubkeyFromHostname(ctx.hostname);
  let pubkey: string | undefined;
  let identifier = "";

  let fallthrough = false;
  if (!resolved && NSITE_HOMEPAGE && (!PUBLIC_DOMAIN || ctx.hostname === PUBLIC_DOMAIN)) {
    const parsed = nip19.decode(NSITE_HOMEPAGE);
    // TODO: use the relays in the nprofile

    if (parsed.type === "nprofile") pubkey = parsed.data.pubkey;
    else if (parsed.type === "npub") pubkey = parsed.data;

    // Fallback to public dir if path cannot be found on the nsite homepage
    if (pubkey) fallthrough = true;
  } else if (resolved) {
    pubkey = resolved.pubkey;
    identifier = resolved.identifier;
  }

  if (!pubkey) {
    if (fallthrough) return next();

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
  let [userServers, event] = await Promise.all([
    getUserBlossomServers(pubkey, relays).then((s) => s || []),
    getNsiteBlob(pubkey, ctx.path, relays, identifier).then((e) => {
      if (!e) return getNsiteBlob(pubkey, "/404.html", relays, identifier);
      else return e;
    }),
  ]);

  if (!event) {
    if (fallthrough) return next();

    ctx.status = 404;
    ctx.body = `Not Found: The requested path "${ctx.path}" could not be found on this site.`;
    return;
  }

  // Prioritize servers: manifest servers first, then user's 10063 servers, then configured servers
  const servers: string[] = [];
  const seen = new Set<string>();

  // Helper to add server only if not seen
  function addServer(server: string) {
    if (!seen.has(server)) {
      seen.add(server);
      servers.push(server);
    }
  }

  // 1. Try manifest server hints first (if available)
  if (event.servers && event.servers.length > 0) {
    event.servers.forEach(addServer);
  }

  // 2. Fall back to user's 10063 blossom servers
  userServers.forEach(addServer);

  // 3. Always include configured BLOSSOM_SERVERS as final fallback
  BLOSSOM_SERVERS.forEach(addServer);

  // Per NIP spec: If no servers are available, respond with 404
  if (servers.length === 0) {
    ctx.status = 404;
    ctx.body = "Not Found: No blossom servers available";
    return;
  }

  try {
    // Prepare headers for range requests
    const requestHeaders: Record<string, string> = {};
    if (ctx.headers.range) {
      requestHeaders.range = ctx.headers.range;
    }

    const res = await streamBlob(event.sha256, servers, requestHeaders, {
      pubkey,
      blossomProxy: BLOSSOM_PROXY,
    });
    if (!res) {
      ctx.status = 502;
      ctx.body = `Bad Gateway: Unable to retrieve the requested file from storage servers.`;
      return;
    }

    const type = mime.getType(event.path);
    if (type) ctx.set("content-type", type);
    else if (res.headers["content-type"]) ctx.set("content-type", res.headers["content-type"]);

    // pass headers along
    if (res.headers["content-length"]) ctx.set("content-length", res.headers["content-length"]);

    // handle range response headers
    if (res.headers["accept-ranges"]) ctx.set("accept-ranges", res.headers["accept-ranges"]);
    if (res.headers["content-range"]) ctx.set("content-range", res.headers["content-range"]);

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

    // set appropriate status code (206 for partial content, 200 for full content)
    ctx.status = res.statusCode === 206 ? 206 : 200;
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
  console.log("Started on port", HOST);
});

// watch for invalidations
watchInvalidation();

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function shutdown() {
  console.log("Shutting down...");

  // Close all relay connections
  for (const [_url, relay] of pool.relays) relay.close();

  process.exit(0);
}

process.addListener("SIGTERM", shutdown);
process.addListener("SIGINT", shutdown);
