import type { Context } from "@hono/hono";
import { html } from "@hono/hono/html";
import { formatNsiteSubdomain } from "../../helpers/nsite-host.ts";
import { getManifestPaths, NAMED_SITE_MANIFEST_KIND, ROOT_SITE_MANIFEST_KIND } from "../../helpers/site-manifest.ts";
import { eventStore } from "../../services/nostr.ts";
import { npubEncode } from "applesauce-core/helpers";
import { StatusPage, type StatusSite } from "../../pages/status.tsx";

function getManifestIdentifier(event: { kind: number; tags: string[][] }): string | undefined {
  if (event.kind === ROOT_SITE_MANIFEST_KIND) return "";
  const dTag = event.tags.find((t) => t[0] === "d" && t[1] !== undefined)?.[1];
  return dTag && dTag !== "" ? dTag : undefined;
}

function getStatusSites(host: string, protocol: string): StatusSite[] {
  const manifests = eventStore.getTimeline({
    kinds: [ROOT_SITE_MANIFEST_KIND, NAMED_SITE_MANIFEST_KIND],
  });
  const sites: StatusSite[] = [];

  for (const event of manifests) {
    const identifier = getManifestIdentifier(event);
    if (identifier === undefined) continue;

    const paths = getManifestPaths(event);
    const key = `${event.pubkey}:${identifier}`;
    const subdomain = formatNsiteSubdomain(event.pubkey, identifier);
    const siteHostname = subdomain ? `${subdomain}.${host}` : undefined;
    sites.push({
      key,
      pubkey: event.pubkey,
      identifier,
      title: event.tags.find((t) => t[0] === "title")?.[1],
      description: event.tags.find((t) => t[0] === "description")?.[1],
      pathCount: paths.size,
      manifestId: event.id,
      createdAt: event.created_at,
      hostname: siteHostname,
      href: siteHostname ? `${protocol}//${siteHostname}/` : undefined,
      npub: npubEncode(event.pubkey),
    });
  }

  return sites.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.key.localeCompare(b.key);
  });
}

export function statusRoute(c: Context): Response | Promise<Response> {
  const url = new URL(c.req.url);
  const sites = getStatusSites(url.host, url.protocol);
  return c.html(html` <!DOCTYPE html>${(<StatusPage sites={sites} host={url.host} />)} `, 200, {
    "Cache-Control": "no-store",
  });
}
