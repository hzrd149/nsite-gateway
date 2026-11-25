import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { contentType } from "@std/media-types";
import { extname } from "@std/path/posix";
import {
  BLOSSOM_PROXY,
  ONION_HOST,
  SITE_CACHE_MAX_AGE,
  SITE_LOADING_PAGE,
} from "../env.ts";
import { createStrongEtag } from "../helpers/http-cache.ts";
import {
  formatNsiteSubdomain,
  formatSnapshotSubdomain,
} from "../helpers/nsite-host.ts";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import type { RequestLogEnv } from "../helpers/request-log.ts";
import {
  getManifestPaths,
  resolveManifestPath,
} from "../helpers/site-manifest.ts";
import {
  LOADING_POLL_HEADER,
  wantsLoadingPage,
  type WarmupOutcome,
  withinGrace,
} from "../helpers/site-loading.ts";
import { PathNotFound } from "../pages/path-not-found.tsx";
import { SiteLoading } from "../pages/site-loading.tsx";
import { SiteNotFound } from "../pages/site-not-found.tsx";
import { isBotUserAgent } from "../helpers/bots.ts";
import { incrementHitCount } from "../services/analytics.ts";
import { streamBlob, verifiedBlobCache } from "../services/blossom.ts";
import { getManifest, getUserBlossomServers } from "../services/nostr.ts";
import { recordServe } from "../services/site-telemetry.ts";
import {
  getSiteBlobServers,
  getSiteWarmup,
  getSiteWarmupFailure,
  isSiteFileReady,
  siteWarmupKey,
  warmSiteFile,
} from "../services/site-warmup.ts";

/** How long a cold navigation waits before falling back to the loading page */
const LOADING_GRACE_MS = 400;

/** Longest a progress poll is held open waiting for the next change */
const POLL_HOLD_MS = 25_000;

/**
 * Most progress polls held open at once. Past this, polls are answered right
 * away with a longer retry hint so idle connections stay bounded.
 */
const MAX_HELD_POLLS = 1024;

/** Retry hint in seconds for polls answered without being held */
const POLL_RETRY_SECONDS = 10;

let heldPolls = 0;

const POLL_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

/** Headers that keep the loading page out of every cache and search index */
const LOADING_HEADERS = {
  "Retry-After": "2",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

function siteNotFound(c: Context<RequestLogEnv>, hostname: string) {
  return c.html(
    html`
      <!DOCTYPE html>${<SiteNotFound hostname={hostname} />}
    `,
    404,
  );
}

function badGateway() {
  return new Response(
    "Bad Gateway: Unable to retrieve the requested file from storage servers.",
    { status: 502 },
  );
}

/** Renders a warm-up failure the browser was sent back to after reloading */
async function warmupFailure(
  c: Context<RequestLogEnv>,
  hostname: string,
  outcome: WarmupOutcome,
): Promise<Response | undefined> {
  if (outcome === "no-manifest") return await siteNotFound(c, hostname);
  if (outcome === "unavailable") return badGateway();
  return undefined;
}

/**
 * Answers browser navigations to cold sites with a temporary loading page
 * (503 + Retry-After, never cached) while the manifest and file are fetched
 * in the background. Returns undefined when the request should be served
 * normally.
 */
async function handleLoadingPage(
  c: Context<RequestLogEnv>,
  site: ResolvedSiteAddress,
  url: URL,
): Promise<Response | undefined> {
  const request = c.req.raw;
  if (request.method !== "GET") return undefined;
  const key = siteWarmupKey(site, url.pathname);

  // Progress polls from the loading page. A poll never starts work: it only
  // waits on an existing job, so its cost is a map lookup and an idle socket.
  const poll = request.headers.get(LOADING_POLL_HEADER);
  if (poll !== null) {
    const job = getSiteWarmup(key);
    // Long poll: hold until the job finishes or moves past the stage the page
    // already shows, so each tab makes a handful of requests per load
    // instead of one per second.
    if (job && job.outcome === undefined && job.stage === poll) {
      if (heldPolls >= MAX_HELD_POLLS) {
        return c.json(
          { stage: job.stage, retry: POLL_RETRY_SECONDS },
          200,
          POLL_HEADERS,
        );
      }
      heldPolls++;
      try {
        await withinGrace(
          Promise.race([job.done, job.changed]),
          POLL_HOLD_MS,
          request.signal,
        );
      } finally {
        heldPolls--;
      }
    }
    const body = job && job.outcome === undefined
      ? { stage: job.stage }
      : { done: true };
    return c.json(body, 200, POLL_HEADERS);
  }

  if (!wantsLoadingPage(request)) return undefined;

  // A reload after a failed warm-up shows the real error instead of looping.
  const failure = getSiteWarmupFailure(key);
  if (failure) return await warmupFailure(c, url.hostname, failure);

  if (isSiteFileReady(site, url.pathname)) return undefined;

  // Too many warm-ups running: wait for the real response like before.
  const job = warmSiteFile(site, url.pathname);
  if (!job) return undefined;
  const outcome = await withinGrace(job.done, LOADING_GRACE_MS);
  if (outcome) return await warmupFailure(c, url.hostname, outcome);

  return await c.html(
    html`
      <!DOCTYPE html>${(
        <SiteLoading
          hostname={url.hostname}
          stage={job.stage}
        />
      )}
    `,
    503,
    LOADING_HEADERS,
  );
}

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
  c: Context<RequestLogEnv>,
  site: ResolvedSiteAddress,
): Promise<Response> {
  const request = c.req.raw;
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const pubkey = site.type === "replaceable" ? site.pubkey : undefined;
  const identifier = site.type === "replaceable" ? site.identifier : "";

  if (SITE_LOADING_PAGE) {
    const loading = await handleLoadingPage(c, site, url);
    if (loading) return loading;
  }

  const manifest = await getManifest(site, 10_000);
  if (!manifest) return siteNotFound(c, url.hostname);

  const match = resolveManifestPath(manifest, url.pathname);
  if (!match) {
    recordServe(site, url.pathname, { status: 404, result: "path-not-found" });
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

  // Count human page views of .html pages (including 404.html)
  if (
    method === "GET" && match.path.endsWith(".html") &&
    !isBotUserAgent(request.headers.get("user-agent"))
  ) {
    void incrementHitCount(manifest.pubkey, identifier);
  }

  // Conditional responses are evaluated only after local bytes are verified.
  const etag = createStrongEtag(match.sha256);

  // The author's server list is only needed to fill a blob not yet on disk.
  const userServers = verifiedBlobCache.has(match.sha256)
    ? undefined
    : await getUserBlossomServers(manifest.pubkey, 10_000);
  const servers = getSiteBlobServers(manifest, userServers);

  // Create request headers for the blob request
  const requestHeaders = new Headers();
  if (!match.is404) {
    for (const name of ["range", "if-range", "if-none-match"]) {
      const value = request.headers.get(name);
      if (value) requestHeaders.set(name, value);
    }
  }

  // Fill if necessary, then serve only verified local bytes.
  let source: string | undefined;
  const upstream = await streamBlob(match.sha256, servers, {
    method,
    headers: requestHeaders,
    pubkey: manifest.pubkey,
    blossomProxy: BLOSSOM_PROXY,
    signal: request.signal,
    observation: c.get("blobObservation"),
    onSource: (server) => source = server,
  });

  if (!upstream || upstream.status >= 500) {
    recordServe(site, match.path, {
      status: upstream?.status ?? 502,
      result: "unavailable",
    });
  }
  if (!upstream) return badGateway();
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
  // source is only set when this request filled the cache from a server
  recordServe(site, match.is404 ? url.pathname : match.path, {
    status,
    result: match.is404 ? "path-not-found" : "served",
    server: source,
  });
  const body = method === "HEAD" ? null : upstream.body;
  return new Response(body, { status, headers });
}
