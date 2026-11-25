import type { Child, FC } from "@hono/hono/jsx";
import { css } from "../helpers/inline-css.ts";
import {
  type DirectoryAuthor,
  type DirectorySite,
  getPubkeyHue,
  sparkline,
  TRENDING_DAYS,
} from "../helpers/directory.ts";

/** Short content hash of styles.css for cache busting */
export const CSS_VERSION = await crypto.subtle
  .digest("SHA-1", new TextEncoder().encode(css))
  .then((hash) =>
    Array.from(
      new Uint8Array(hash).slice(0, 6),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
  );

export const Layout: FC<{
  title: string;
  description?: string;
  noindex?: boolean;
  class?: string;
  children: Child;
}> = ({ title, description, noindex, children, ...props }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      {description && <meta name="description" content={description} />}
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      <link rel="stylesheet" href={`/styles.css?v=${CSS_VERSION}`} />
    </head>
    <body>
      <main class={props.class}>{children}</main>
    </body>
  </html>
);

/** Context needed to build absolute site URLs on this gateway */
export type GatewayContext = { protocol: string; host: string };

export function siteHref(
  gateway: GatewayContext,
  subdomain: string | undefined,
): string | undefined {
  return subdomain
    ? `${gateway.protocol}//${subdomain}.${gateway.host}/`
    : undefined;
}

export function formatDateTime(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export const Chip: FC<{ pubkey: string; label: string; large?: boolean }> = (
  { pubkey, label, large },
) => (
  <i
    class={large ? "chip lg" : "chip"}
    style={`--h:${getPubkeyHue(pubkey)}`}
    aria-hidden="true"
  >
    {(label.replace(/^npub1/, "")[0] ?? "?").toUpperCase()}
  </i>
);

export const Spark: FC<{ values: number[] }> = ({ values }) => (
  <span
    class="spark"
    title={`visits per day, last ${TRENDING_DAYS} days: ${values.join(", ")}`}
  >
    {sparkline(values)}
  </span>
);

export const AddressForm: FC<{ value?: string }> = ({ value }) => (
  <form class="open" action="/search" method="get" role="search">
    <input
      id="search"
      name="q"
      type="search"
      value={value}
      maxlength={200}
      aria-label="Search sites and authors, or open an address"
      placeholder="search sites & authors, or paste npub / naddr"
      autocomplete="off"
      spellcheck={false}
      required
    />
    <button type="submit">go</button>
  </form>
);

export const TopBar: FC<{
  gateway: GatewayContext;
  subtitle: Child;
  address?: string;
  chip?: { pubkey: string; label: string };
}> = ({ gateway, subtitle, address, chip }) => (
  <div class="top">
    <a class="brand" href="/">
      {chip && <Chip pubkey={chip.pubkey} label={chip.label} large />}
      {gateway.host} <small>/ {subtitle}</small>
    </a>
    <AddressForm value={address} />
  </div>
);

export const SiteName: FC<{ site: DirectorySite; gateway: GatewayContext }> = (
  { site, gateway },
) => {
  const href = siteHref(gateway, site.subdomain);
  return (
    <a href={href ?? site.statusPath} title={site.label}>
      {site.label}
    </a>
  );
};

/** Absolute UTC time; cached pages must not contain relative ages */
export const Age: FC<{ unix: number }> = ({ unix }) => (
  <time datetime={new Date(unix * 1000).toISOString()}>
    {formatDateTime(unix)}
  </time>
);

export const AuthorLink: FC<{ author?: DirectoryAuthor; pubkey: string }> = (
  { author, pubkey },
) => <a href={`/author/${author?.npub ?? pubkey}`}>{author?.label ?? pubkey}
</a>;
