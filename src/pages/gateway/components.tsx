import type { Child, FC } from "@hono/hono/jsx";
import {
  type Directory,
  type DirectoryAuthor,
  type DirectorySite,
  TRENDING_DAYS,
} from "../../helpers/directory.ts";
import {
  formatCount,
  formatDateTime,
  getPubkeyHue,
  sparkline,
} from "../../helpers/format.ts";

/** Context needed to build absolute site URLs on this gateway */
export type GatewayContext = { protocol: string; host: string };

export function getGatewayContext(requestUrl: string): GatewayContext {
  const url = new URL(requestUrl);
  return { protocol: url.protocol, host: url.host };
}

export function siteHref(
  gateway: GatewayContext,
  subdomain: string | undefined,
): string | undefined {
  return subdomain
    ? `${gateway.protocol}//${subdomain}.${gateway.host}/`
    : undefined;
}

/** Text meant to be copied: one click or double-click selects all of it */
export const Copy: FC<{ children: Child; class?: string; title?: string }> = (
  { children, ...props },
) => (
  <span
    class={props.class ? `copy ${props.class}` : "copy"}
    title={props.title}
  >
    {children}
  </span>
);

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

const SearchForm: FC<{ value?: string }> = ({ value }) => (
  <form class="search" action="/search" method="get" role="search">
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
  query?: string;
  chip?: { pubkey: string; label: string };
}> = ({ gateway, subtitle, query, chip }) => (
  <div class="top">
    <a class="brand" href="/">
      {chip && <Chip pubkey={chip.pubkey} label={chip.label} large />}
      {gateway.host} <small>/ {subtitle}</small>
    </a>
    <SearchForm value={query} />
  </div>
);

/** Absolute UTC time; cached pages must not contain relative ages */
const Time: FC<{ unix: number }> = ({ unix }) => (
  <time datetime={new Date(unix * 1000).toISOString()}>
    {formatDateTime(unix)}
  </time>
);

const SiteName: FC<{ site: DirectorySite; gateway: GatewayContext }> = (
  { site, gateway },
) => (
  <a
    href={siteHref(gateway, site.subdomain) ?? site.statusPath}
    title={site.label}
  >
    {site.label}
  </a>
);

const AuthorLink: FC<{ author?: DirectoryAuthor; pubkey: string }> = (
  { author, pubkey },
) => <a href={`/author/${author?.npub ?? pubkey}`}>{author?.label ?? pubkey}
</a>;

/** Optional columns of a site table, in display order */
export type SiteColumns = {
  author?: boolean;
  client?: boolean;
  snapshots?: boolean;
  status?: boolean;
};

/** Site table with the shared column layout used across gateway pages */
export const SiteTable: FC<{
  sites: DirectorySite[];
  directory: Directory;
  gateway: GatewayContext;
  columns?: SiteColumns;
  /** Replaces plain header labels, e.g. with sort links */
  headers?: { name?: Child; visits?: Child; modified?: Child };
}> = ({ sites, directory, gateway, columns = { author: true }, headers }) => (
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>{headers?.name ?? "name"}</th>
          {columns.author && <th>author</th>}
          {columns.client && <th>client</th>}
          <th class="num">files</th>
          {columns.snapshots && <th class="num">snaps</th>}
          <th>{headers?.visits ?? "7d visits"}</th>
          <th class="num">{headers?.modified ?? "modified (utc)"}</th>
          {columns.status && <th></th>}
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => (
          <tr key={site.key}>
            <td class="name">
              <SiteName site={site} gateway={gateway} />
              {site.description && (
                <span class="desc" title={site.description}>
                  {site.description}
                </span>
              )}
            </td>
            {columns.author && (
              <td>
                <AuthorLink
                  author={directory.authors.get(site.pubkey)}
                  pubkey={site.pubkey}
                />
              </td>
            )}
            {columns.client && (
              <td>
                {site.client
                  ? site.client.href
                    ? <a href={site.client.href}>{site.client.name}</a>
                    : site.client.name
                  : <span class="muted">—</span>}
              </td>
            )}
            <td class="num">{site.pathCount}</td>
            {columns.snapshots && (
              <td class="num">
                {site.latestSnapshotStatus
                  ? (
                    <a href={site.latestSnapshotStatus}>
                      {site.snapshotCount}
                    </a>
                  )
                  : site.snapshotCount}
              </td>
            )}
            <td>
              <Spark values={site.dailyHits} />{" "}
              <span class="num">{formatCount(site.recentHits)}</span>
            </td>
            <td class="num">
              <Time unix={site.updatedAt} />
            </td>
            {columns.status && (
              <td>
                <a href={site.statusPath}>status</a>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Author chip, name and site count, used in sidebars and search */
export const AuthorItem: FC<{ author: DirectoryAuthor; count?: Child }> = (
  { author, count },
) => (
  <li>
    <Chip pubkey={author.pubkey} label={author.label} />
    <a href={`/author/${author.npub}`}>{author.label}</a>
    <span class="n">{count ?? author.siteKeys.length}</span>
  </li>
);
