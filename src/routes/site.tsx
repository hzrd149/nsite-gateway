import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { contentType } from "@std/media-types";
import { extname } from "@std/path/posix";
import { mergeBlossomServers } from "applesauce-common/helpers";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  ONION_HOST,
  SITE_CACHE_MAX_AGE,
} from "../env.ts";
import { createStrongEtag } from "../helpers/http-cache.ts";
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

  // Conditional responses are evaluated only after local bytes are verified.
  const etag = createStrongEtag(match.sha256);

  const manifestServers = getManifestServers(manifest);
  const servers = mergeBlossomServers(
    manifestServers,
    userServers,
    BLOSSOM_SERVERS,
  );

  // Create request headers for the blob request
  const requestHeaders = new Headers();
  if (!match.is404) {
    for (const name of ["range", "if-range", "if-none-match"]) {
      const value = request.headers.get(name);
      if (value) requestHeaders.set(name, value);
    }
  }

  // Fill if necessary, then serve only verified local bytes.
  const upstream = await streamBlob(match.sha256, servers, {
    method,
    headers: requestHeaders,
    pubkey: manifest.pubkey,
    blossomProxy: BLOSSOM_PROXY,
    signal: request.signal,
  });

  if (!upstream) {
    return new Response(
      "Bad Gateway: Unable to retrieve the requested file from storage servers.",
      {
        status: 502,
      },
    );
  }
  if (upstream.status >= 500) return upstream;

  // Create response headers
  const headers = new Headers();
  // The manifest path determines MIME type; unknown extensions use the local
  // cache's application/octet-stream rather than an untrusted source's headers.
  const upstreamContentType = upstream.headers.get("content-type");
  const pathMime = contentType(extname(match.path));
  if (pathMime) {
    headers.set("content-type", pathMime);
  } else if (upstreamContentType) {
    headers.set("content-type", upstreamContentType);
  }

  // Length and ranges were computed from the verified local file.
  for (const name of ["content-length", "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Set response headers
  headers.set("ETag", etag);
  headers.set(
    "Cache-Control",
    `public, max-age=${SITE_CACHE_MAX_AGE}, must-revalidate`,
  );
  headers.set(
    "Last-Modified",
    getSiteLastModified(manifest.created_at),
  );
  appendOnionLocation(headers, site, manifest.pubkey, identifier);

  // Set response status
  const status = match.is404 ? 404 : upstream.status;
  const body = method === "HEAD" ? null : upstream.body;
  return new Response(body, { status, headers });
}
