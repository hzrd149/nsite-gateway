import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { contentType } from "@std/media-types";
import { extname } from "@std/path/posix";
import { mergeBlossomServers } from "applesauce-common/helpers";
import { BLOSSOM_PROXY, BLOSSOM_SERVERS, ONION_HOST } from "../env.ts";
import {
  createStrongEtag,
  hasMatchingIfNoneMatch,
} from "../helpers/http-cache.ts";
import {
  formatNsiteSubdomain,
  formatSnapshotSubdomain,
} from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import {
  getManifestPaths,
  getManifestServers,
  resolveManifestPath,
} from "../helpers/site-manifest.ts";
import { NoBlossomServers } from "../pages/no-blossom-servers.tsx";
import { PathNotFound } from "../pages/path-not-found.tsx";
import { SiteNotFound } from "../pages/site-not-found.tsx";
import { incrementHitCount } from "../services/analytics.ts";
import { streamBlob } from "../services/blossom.ts";
import { getManifest, getUserBlossomServers } from "../services/nostr.ts";

function appendOnionLocation(
  headers: Headers,
  site?: ResolvedSiteAddress,
  pubkey?: string,
  identifier = "",
) {
  if (!ONION_HOST) return;
  const url = new URL(ONION_HOST);
  const subdomain = site?.type === "snapshot"
    ? formatSnapshotSubdomain(site.id)
    : pubkey
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
  site: ResolvedSiteAddress,
): Promise<Response> {
  const request = c.req.raw;
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const pubkey = site.type === "replaceable" ? site.pubkey : undefined;
  const identifier = site.type === "replaceable" ? site.identifier : "";

  const manifest = await getManifest(site, 10_000);

  const userServers = manifest
    ? await getUserBlossomServers(manifest.pubkey, 10_000)
    : undefined;

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
    const paths = [...getManifestPaths(manifest).keys()];
    return c.html(
      html`
        <!DOCTYPE html>${(
          <PathNotFound
            hostname={url.hostname}
            pathname={url.pathname}
            paths={paths}
          />
        )}
      `,
      404,
    );
  }

  // Count hits for .html pages (including 404.html)
  if (match.path.endsWith(".html")) {
    void incrementHitCount(manifest.pubkey, identifier);
  }

  // If the request path is found, create a strong etag and check if the client has a matching if-none-match header
  const etag = createStrongEtag(match.sha256);
  if (!match.is404 && hasMatchingIfNoneMatch(request.headers, etag)) {
    const headers = new Headers();
    headers.set("ETag", etag);
    headers.set("Cache-Control", "public, max-age=3600");
    headers.set("Last-Modified", getSiteLastModified(manifest.created_at));
    appendOnionLocation(headers, site, manifest.pubkey, identifier);
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
    return c.html(
      html`
        <!DOCTYPE html>${<NoBlossomServers hostname={url.hostname} />}
      `,
      404,
    );
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
  const upstreamContentType = upstream.headers.get("content-type");
  const upstreamContentLength = upstream.headers.get("content-length");
  if (upstreamContentType) {
    headers.set("content-type", upstreamContentType);
  } else if (!upstreamContentLength) {
    const mime = contentType(extname(match.path));
    if (mime) headers.set("content-type", mime);
  }

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
  appendOnionLocation(headers, site, manifest.pubkey, identifier);

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
