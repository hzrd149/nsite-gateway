import { contentType } from "@std/media-types";
import { extname, join } from "@std/path/posix";
import { nip19 } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { streamBlob } from "./blossom.ts";
import { resolvePubkeyFromHostname } from "./dns.ts";
import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  MAX_BLOSSOM_SERVERS,
  NSITE_HOMEPAGE,
  ONION_HOST,
  PUBLIC_DOMAIN,
  SUBSCRIPTION_RELAYS,
} from "./env.ts";
import { getNsiteBlob } from "./events.ts";
import { getUserBlossomServers, getUserOutboxes } from "./nostr.ts";
import { serveStaticFile } from "./static.ts";

type SiteResult =
  | {
    response: Response;
    fallthrough?: false;
  }
  | {
    response?: undefined;
    fallthrough: true;
  };

function appendOnionLocation(headers: Headers, pubkey?: string) {
  if (!ONION_HOST) return;
  const url = new URL(ONION_HOST);
  if (pubkey) url.hostname = `${npubEncode(pubkey)}.${url.hostname}`;
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

export async function handleSiteRequest(request: Request): Promise<SiteResult> {
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
    if (pubkey) fallthrough = true;
  } else if (resolved) {
    pubkey = resolved.pubkey;
    identifier = resolved.identifier;
  }

  if (!pubkey) {
    if (fallthrough) return { fallthrough: true };
    return { response: await notFoundPage(url.pathname) };
  }

  const relays = (await getUserOutboxes(pubkey)) || [];
  relays.push(...SUBSCRIPTION_RELAYS);
  if (relays.length === 0) {
    return { response: new Response("No relays found", { status: 502 }) };
  }

  const [userServers, event] = await Promise.all([
    getUserBlossomServers(pubkey, relays).then((servers) => servers || []),
    getNsiteBlob(pubkey, url.pathname, relays, identifier).then((result) => {
      if (result) return result;
      return getNsiteBlob(pubkey!, "/404.html", relays, identifier);
    }),
  ]);

  if (!event) {
    if (fallthrough) return { fallthrough: true };
    return { response: await notFoundPage(url.pathname) };
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
  });

  if (!upstream) {
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

  headers.set("ETag", upstream.headers.get("etag") || `"${event.sha256}"`);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set(
    "Last-Modified",
    upstream.headers.get("last-modified") ||
      new Date(event.created_at * 1000).toUTCString(),
  );
  appendOnionLocation(headers, pubkey);

  const status = upstream.status === 206
    ? 206
    : upstream.ok
    ? 200
    : upstream.status;
  const body = method === "HEAD" ? null : upstream.body;
  return { response: new Response(body, { status, headers }) };
}
