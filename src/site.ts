import { contentType } from "@std/media-types";
import { extname, join } from "@std/path/posix";
import { relaySet } from "applesauce-core/helpers";
import { nip19 } from "nostr-tools";
import { getNsiteBlob } from "./helpers/events.ts";
import {
  createStrongEtag,
  hasMatchingIfNoneMatch,
} from "./helpers/http-cache.ts";
import { formatNsiteSubdomain } from "./helpers/nsite-host.ts";
import type { RequestLog } from "./helpers/request-log.ts";
import { BLOB_SOURCE_HEADER, streamBlob } from "./services/blossom.ts";
import { resolvePubkeyFromHostname } from "./services/dns.ts";
import { getUserBlossomServers, getUserOutboxes } from "./services/nostr.ts";
import { serveStaticFile } from "./services/static.ts";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  MAX_BLOSSOM_SERVERS,
  NSITE_HOMEPAGE,
  ONION_HOST,
  PUBLIC_DOMAIN,
  SUBSCRIPTION_RELAYS,
} from "./helpers/env.ts";

type SiteResult =
  | {
    response: Response;
    fallthrough?: false;
  }
  | {
    response?: undefined;
    fallthrough: true;
  };

function appendOnionLocation(
  headers: Headers,
  pubkey?: string,
  identifier = "",
) {
  if (!ONION_HOST) return;
  const url = new URL(ONION_HOST);
  if (pubkey) {
    url.hostname = `${
      formatNsiteSubdomain(pubkey, identifier)
    }.${url.hostname}`;
  }
  headers.set("Onion-Location", url.toString().replace(/\/$/, ""));
}

function getHomepagePubkey(): string | undefined {
  const parsed = nip19.decode(NSITE_HOMEPAGE);
  if (parsed.type === "nprofile") return parsed.data.pubkey;
  if (parsed.type === "npub") return parsed.data;
  return undefined;
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
  requestLog?: RequestLog,
): Promise<SiteResult> {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const method = request.method === "HEAD" ? "HEAD" : "GET";

  const resolved = await resolvePubkeyFromHostname(hostname);
  let pubkey: string | undefined;
  let identifier = "";
  let fallthrough = false;

  if (
    !resolved && NSITE_HOMEPAGE &&
    (!PUBLIC_DOMAIN || hostname === PUBLIC_DOMAIN)
  ) {
    pubkey = getHomepagePubkey();
    if (pubkey) {
      fallthrough = true;
    }
  } else if (resolved) {
    pubkey = resolved.pubkey;
    identifier = resolved.identifier;
  }

  if (!pubkey) {
    if (fallthrough) return { fallthrough: true };
    requestLog?.setOutcome("site-404");
    return { response: await notFoundPage(url.pathname) };
  }

  const relays = relaySet(await getUserOutboxes(pubkey), SUBSCRIPTION_RELAYS) ||
    [];
  if (relays.length === 0) {
    requestLog?.setOutcome("site-no-relays");
    return { response: new Response("No relays found", { status: 502 }) };
  }

  const [userServers, lookup] = await Promise.all([
    getUserBlossomServers(pubkey, relays).then((servers) => servers || []),
    getNsiteBlob(pubkey, url.pathname, relays, identifier, requestLog),
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
      requestLog,
    );

    if (notFoundLookup.kind === "hit") {
      event = notFoundLookup.event;
      serveNotFound = true;
    } else {
      if (lookup.kind === "manifest-miss") {
        requestLog?.addFields({ src: "manifest" });
      }
      requestLog?.setOutcome("site-404");
      return { response: await notFoundPage(url.pathname) };
    }
  }

  if (!event) {
    requestLog?.setOutcome("site-404");
    return { response: await notFoundPage(url.pathname) };
  }

  const etag = createStrongEtag(event.sha256);
  if (!serveNotFound && hasMatchingIfNoneMatch(request.headers, etag)) {
    const headers = new Headers();
    headers.set("ETag", etag);
    headers.set("Cache-Control", "public, max-age=3600");
    headers.set("Last-Modified", getSiteLastModified(event.created_at));
    appendOnionLocation(headers, pubkey, identifier);
    requestLog?.setOutcome("site-not-modified");
    return { response: new Response(null, { status: 304, headers }) };
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
    requestLog?.setOutcome("site-no-servers");
    return {
      response: new Response("Not Found: No blossom servers available", {
        status: 404,
      }),
    };
  }

  const requestHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) requestHeaders.set("range", range);

  const upstream = await streamBlob(event.sha256, servers, {
    method,
    headers: requestHeaders,
    pubkey,
    blossomProxy: BLOSSOM_PROXY,
    requestLog,
  });

  if (!upstream) {
    requestLog?.setOutcome("upstream-fail");
    return {
      response: new Response(
        "Bad Gateway: Unable to retrieve the requested file from storage servers.",
        {
          status: 502,
        },
      ),
    };
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

  requestLog?.setOutcome(serveNotFound ? "site-404" : "site-hit");

  const status = serveNotFound
    ? 404
    : upstream.status === 206
    ? 206
    : upstream.ok
    ? 200
    : upstream.status;
  const body = method === "HEAD" ? null : upstream.body;
  return { response: new Response(body, { status, headers }) };
}
