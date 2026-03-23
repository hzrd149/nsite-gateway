import { contentType } from "@std/media-types";
import { extname, join } from "@std/path/posix";
import { relaySet } from "applesauce-core/helpers";
import { getNsiteBlob } from "./helpers/events.ts";
import {
  createStrongEtag,
  hasMatchingIfNoneMatch,
} from "./helpers/http-cache.ts";
import { formatNsiteSubdomain } from "./helpers/nsite-host.ts";
import { BLOB_SOURCE_HEADER, streamBlob } from "./services/blossom.ts";
import { getUserBlossomServers, getUserOutboxes } from "./services/nostr.ts";
import { serveStaticFile } from "./services/static.ts";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  LOOKUP_RELAYS,
  MAX_BLOSSOM_SERVERS,
  ONION_HOST,
} from "./helpers/env.ts";

export type ResolvedSite = {
  pubkey: string;
  identifier: string;
};

function appendOnionLocation(
  headers: Headers,
  pubkey?: string,
  identifier = "",
) {
  if (!ONION_HOST) return;
  const url = new URL(ONION_HOST);
  const subdomain = pubkey
    ? formatNsiteSubdomain(pubkey, identifier)
    : undefined;
  if (subdomain) {
    url.hostname = `${subdomain}.${url.hostname}`;
  }
  headers.set("Onion-Location", url.toString().replace(/\/$/, ""));
}

async function notFoundPage(pathname: string): Promise<Response> {
  const file = await serveStaticFile(
    join(Deno.cwd(), "public"),
    "/404.html",
    "GET",
    404,
  );
  if (file) return file;
  return new Response(
    `Not Found: The requested path "${pathname}" could not be found on this site.`,
    { status: 404 },
  );
}

function getSiteLastModified(createdAt: number): string {
  return new Date(createdAt * 1000).toUTCString();
}

export async function handleSiteRequest(
  request: Request,
  site: ResolvedSite,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const { pubkey, identifier } = site;

  const relays = relaySet(await getUserOutboxes(pubkey), LOOKUP_RELAYS) ||
    [];
  if (relays.length === 0) {
    return new Response("No relays found", { status: 502 });
  }

  const [userServers, lookup] = await Promise.all([
    getUserBlossomServers(pubkey, relays).then((servers) => servers || []),
    getNsiteBlob(pubkey, url.pathname, relays, identifier),
  ]);

  let event;
  let serveNotFound = false;

  if (lookup.kind === "hit") {
    event = lookup.event;
  } else {
    const notFoundLookup = await getNsiteBlob(
      pubkey,
      "/404.html",
      relays,
      identifier,
    );

    if (notFoundLookup.kind === "hit") {
      event = notFoundLookup.event;
      serveNotFound = true;
    } else {
      return await notFoundPage(url.pathname);
    }
  }

  if (!event) {
    return await notFoundPage(url.pathname);
  }

  const etag = createStrongEtag(event.sha256);
  if (!serveNotFound && hasMatchingIfNoneMatch(request.headers, etag)) {
    const headers = new Headers();
    headers.set("ETag", etag);
    headers.set("Cache-Control", "public, max-age=3600");
    headers.set("Last-Modified", getSiteLastModified(event.created_at));
    appendOnionLocation(headers, pubkey, identifier);
    return new Response(null, { status: 304, headers });
  }

  const servers: string[] = [];
  const seen = new Set<string>();
  for (
    const server of [
      ...(event.servers || []),
      ...userServers,
      ...BLOSSOM_SERVERS,
    ]
  ) {
    if (!seen.has(server)) {
      seen.add(server);
      servers.push(server);
      if (servers.length >= MAX_BLOSSOM_SERVERS) break;
    }
  }
  if (servers.length === 0) {
    return new Response("Not Found: No blossom servers available", {
      status: 404,
    });
  }

  const requestHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) requestHeaders.set("range", range);

  const upstream = await streamBlob(event.sha256, servers, {
    method,
    headers: requestHeaders,
    pubkey,
    blossomProxy: BLOSSOM_PROXY,
  });

  if (!upstream) {
    return new Response(
      "Bad Gateway: Unable to retrieve the requested file from storage servers.",
      {
        status: 502,
      },
    );
  }

  const headers = new Headers();
  const mime = contentType(extname(event.path));
  headers.set(
    "content-type",
    mime || upstream.headers.get("content-type") || "application/octet-stream",
  );

  for (const name of ["content-length", "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  const blobSource = upstream.headers.get(BLOB_SOURCE_HEADER);
  if (blobSource) headers.set(BLOB_SOURCE_HEADER, blobSource);

  headers.set("ETag", etag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set(
    "Last-Modified",
    upstream.headers.get("last-modified") ||
      getSiteLastModified(event.created_at),
  );
  appendOnionLocation(headers, pubkey, identifier);

  const status = serveNotFound
    ? 404
    : upstream.status === 206
    ? 206
    : upstream.ok
    ? 200
    : upstream.status;
  const body = method === "HEAD" ? null : upstream.body;
  return new Response(body, { status, headers });
}
