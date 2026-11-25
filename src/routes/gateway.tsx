import { type Context, Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { html } from "@hono/hono/html";
import { decodePointer } from "applesauce-core/helpers";
import denoConfig from "../../deno.json" with { type: "json" };
import { DIRECTORY_REFRESH } from "../env.ts";
import type { Directory } from "../helpers/directory.ts";
import { hasMatchingIfNoneMatch } from "../helpers/http-cache.ts";
import { css } from "../helpers/inline-css.ts";
import { getSiteSubdomain, parseSiteAddress } from "../helpers/site-address.ts";
import { normalizeQuery, searchDirectory } from "../helpers/search.ts";
import { AuthorNotFoundPage, AuthorPage } from "../pages/gateway/author.tsx";
import {
  type GatewayContext,
  getGatewayContext,
  siteHref,
} from "../pages/gateway/components.tsx";
import { HomePage, type HomeTab } from "../pages/gateway/home.tsx";
import { CSS_VERSION } from "../pages/gateway/layout.tsx";
import { SearchPage } from "../pages/gateway/search.tsx";
import {
  getSitesPageCount,
  SitesPage,
  type SitesSort,
} from "../pages/gateway/sites.tsx";
import { verifiedBlobCache } from "../services/blossom.ts";
import { getCachedPage, getDirectory } from "../services/directory.ts";
import { getLastRelaySync, pool } from "../services/nostr.ts";
import { siteStatusRoute } from "./status.tsx";

const router = new Hono();
const startedAt = Date.now();

const servePublicFile = serveStatic({
  root: "./public",
  rewriteRequestPath: (path) => path === "/" ? "/index.html" : path,
});

async function isPublicFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(`public/${path}`)).isFile;
  } catch {
    return false;
  }
}

const hasPublicIndex = await isPublicFile("index.html");
const hasPublicRobots = await isPublicFile("robots.txt");

const DEFAULT_ROBOTS = `User-agent: *
Disallow: /status/
Disallow: /search
Allow: /
`;

router.onError((error) => {
  console.error("Gateway page error", error);
  return new Response("Internal Server Error", { status: 500 });
});

/** Serves a page rendered from the directory snapshot with HTTP caching */
async function cachedPage(
  c: Context,
  key: string,
  render: (directory: Directory, gateway: GatewayContext) => unknown,
  options: { search?: boolean } = {},
): Promise<Response> {
  const gateway = getGatewayContext(c.req.url);
  // Links embed the host, so cache per root host (a small, fixed set)
  const page = await getCachedPage(
    `${gateway.protocol}//${gateway.host}${key}`,
    async (directory) =>
      String(
        await html`<!DOCTYPE html>${render(directory, gateway)}`,
      ),
    options.search ? "search" : "pages",
  );
  const headers: Record<string, string> = {
    "Cache-Control": `public, max-age=${
      options.search ? Math.min(60, DIRECTORY_REFRESH) : DIRECTORY_REFRESH
    }`,
    ETag: page.etag,
  };
  if (options.search) headers["X-Robots-Tag"] = "noindex";
  if (hasMatchingIfNoneMatch(c.req.raw.headers, page.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return c.html(page.body, 200, headers);
}

router.get("/styles.css", (c) => {
  const etag = `"${CSS_VERSION}"`;
  const headers = {
    "Content-Type": "text/css; charset=utf-8",
    ETag: etag,
    "Cache-Control": c.req.query("v") === CSS_VERSION
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
  };
  if (hasMatchingIfNoneMatch(c.req.raw.headers, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return c.body(css, 200, headers);
});

router.get("/robots.txt", async (c, next) => {
  if (hasPublicRobots) return await servePublicFile(c, next);
  return c.text(DEFAULT_ROBOTS, 200, {
    "Cache-Control": "public, max-age=86400",
  });
});

router.get("/", async (c, next) => {
  if (hasPublicIndex) return await servePublicFile(c, next);
  const tab: HomeTab = c.req.query("tab") === "trending"
    ? "trending"
    : "recent";
  return await cachedPage(
    c,
    `/?tab=${tab}`,
    (directory, gateway) => (
      <HomePage directory={directory} gateway={gateway} tab={tab} />
    ),
  );
});

router.get("/search", async (c) => {
  const input = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!input) return c.redirect("/", 302);

  // A pasted site address opens the site directly
  const parsed = parseSiteAddress(input);
  const gateway = getGatewayContext(c.req.url);
  const href = parsed && siteHref(gateway, getSiteSubdomain(parsed));
  if (href) return c.redirect(href, 302);

  const query = normalizeQuery(input);
  const notice = parsed
    ? "This named site's identifier can't be used as a subdomain, so it can't be opened here."
    : undefined;
  return await cachedPage(
    c,
    `/search?q=${query}${notice ? "&notice" : ""}`,
    (directory, gateway) => (
      <SearchPage
        directory={directory}
        gateway={gateway}
        results={searchDirectory(directory, query)}
        notice={notice}
      />
    ),
    { search: true },
  );
});

router.get("/sites", async (c) => {
  const sortParam = c.req.query("sort");
  const sort: SitesSort = sortParam === "trending" || sortParam === "name"
    ? sortParam
    : "updated";
  const pages = getSitesPageCount(getDirectory());
  const requested = parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), pages)
    : 1;
  return await cachedPage(
    c,
    `/sites?sort=${sort}&page=${page}`,
    (directory, gateway) => (
      <SitesPage
        directory={directory}
        gateway={gateway}
        sort={sort}
        page={Math.min(page, getSitesPageCount(directory))}
      />
    ),
  );
});

function parsePubkey(input: string): string | undefined {
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  try {
    const result = decodePointer(input);
    if (result.type === "npub") return result.data;
    if (result.type === "nprofile") return result.data.pubkey;
  } catch {
    // ignore
  }
  return undefined;
}

router.get("/author/:id", async (c) => {
  const pubkey = parsePubkey(c.req.param("id"));
  if (!pubkey || !getDirectory().authors.has(pubkey)) {
    return c.html(
      html`<!DOCTYPE html>${(
        <AuthorNotFoundPage gateway={getGatewayContext(c.req.url)} />
      )}`,
      404,
      { "Cache-Control": `public, max-age=${DIRECTORY_REFRESH}` },
    );
  }
  return await cachedPage(
    c,
    `/author/${pubkey}`,
    (directory, gateway) =>
      directory.authors.has(pubkey)
        ? <AuthorPage directory={directory} gateway={gateway} pubkey={pubkey} />
        : <AuthorNotFoundPage gateway={gateway} />,
  );
});

router.get("/status", (c) => c.redirect("/sites", 301));
router.get("/status/:address", (c) => siteStatusRoute(c));

router.get("/health", (c) => {
  const directory = getDirectory();
  let relaysConnected = 0;
  for (const [, relay] of pool.relays) if (relay.connected) relaysConnected++;
  const lastSync = getLastRelaySync();
  return c.json(
    {
      status: "ok",
      version: denoConfig.version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      sites: directory.stats.sites,
      authors: directory.stats.authors,
      directoryBuiltAt: new Date(directory.builtAt).toISOString(),
      relays: { connected: relaysConnected, total: pool.relays.size },
      lastRelaySync: lastSync ? new Date(lastSync).toISOString() : null,
      blobCache: verifiedBlobCache.metrics,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

router.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  return await servePublicFile(c, next);
});

router.notFound(async () => {
  try {
    const body = await Deno.readTextFile("public/404.html");
    return new Response(body, {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
});

export async function handleLocalRouter(request: Request): Promise<Response> {
  return await router.fetch(request);
}
