import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { contentType } from "@std/media-types";
import { extname } from "@std/path/posix";
import { mergeBlossomServers } from "applesauce-common/helpers";
import type { AddressPointer } from "applesauce-core/helpers";
import { BLOSSOM_PROXY, BLOSSOM_SERVERS, ONION_HOST } from "../env.ts";
import {
  createStrongEtag,
  hasMatchingIfNoneMatch,
} from "../helpers/http-cache.ts";
import { formatNsiteSubdomain } from "../helpers/nsite-host.ts";
import {
  getManifestServers,
  resolveManifestPath,
} from "../helpers/site-manifest.ts";
import { PathNotFound } from "../pages/path-not-found.tsx";
import { SiteNotFound } from "../pages/site-not-found.tsx";
import { incrementHitCount } from "../services/analytics.ts";
import { streamBlob } from "../services/blossom.ts";
import { getManifest, getUserBlossomServers } from "../services/nostr.ts";

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

function getSiteLastModified(createdAt: number): string {
  return new Date(createdAt * 1000).toUTCString();
}

export async function handleSiteRequest(
  c: Context,
  site: AddressPointer,
): Promise<Response> {
  const request = c.req.raw;
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const { pubkey, identifier } = site;

  // Load the users blossom servers and manifest event in parallel
  const [userServers, manifest] = await Promise.all([
    getUserBlossomServers(pubkey, 10_000),
    getManifest(site, 10_000),
  ]);

  if (!manifest) {
    return c.html(
      html`
        <!DOCTYPE html>${<SiteNotFound hostname={url.hostname} />}
      `,
      404,
    );
  }

  const match = resolveManifestPath(manifest, url.pathname);
  if (!match) {
    return c.html(
      html`
        <!DOCTYPE html>${(
          <PathNotFound hostname={url.hostname} pathname={url.pathname} />
        )}
      `,
      404,
    );
  }

  // Count hits for .html pages (including 404.html)
  if (match.path.endsWith(".html")) {
    void incrementHitCount(pubkey, identifier ?? "");
  }

  // If the request path is found, create a strong etag and check if the client has a matching if-none-match header
  const etag = createStrongEtag(match.sha256);
  if (!match.is404 && hasMatchingIfNoneMatch(request.headers, etag)) {
    const headers = new Headers();
    headers.set("ETag", etag);
    headers.set("Cache-Control", "public, max-age=3600");
    headers.set("Last-Modified", getSiteLastModified(manifest.created_at));
    appendOnionLocation(headers, pubkey, identifier);
    return new Response(null, { status: 304, headers });
  }

  const manifestServers = getManifestServers(manifest);
  const servers = mergeBlossomServers(
    manifestServers,
    userServers,
    BLOSSOM_SERVERS,
  );

  // If no servers are available, return a 404
  if (servers.length === 0) {
    return new Response("Not Found: No blossom servers available", {
      status: 404,
    });
  }

  // Create request headers for the blob request
  const requestHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) requestHeaders.set("range", range);

  // Get an upstream stream from one of the servers
  const upstream = await streamBlob(match.sha256, servers, {
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

  // Create response headers
  const headers = new Headers();
  const mime = contentType(extname(match.path));
  headers.set(
    "content-type",
    mime || upstream.headers.get("content-type") || "application/octet-stream",
  );

  // Copy response headers from the upstream response
  for (const name of ["content-length", "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Set response headers
  headers.set("ETag", etag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set(
    "Last-Modified",
    upstream.headers.get("last-modified") ||
      getSiteLastModified(manifest.created_at),
  );
  appendOnionLocation(headers, pubkey, identifier);

  // Set response status
  const status = match.is404
    ? 404
    : upstream.status === 206
    ? 206
    : upstream.ok
    ? 200
    : upstream.status;
  const body = method === "HEAD" ? null : upstream.body;
  return new Response(body, { status, headers });
}
