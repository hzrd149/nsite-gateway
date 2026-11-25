import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../helpers/directory.ts";
import { SiteRows } from "./home.tsx";
import { type GatewayContext, Layout, pluralize, TopBar } from "./layout.tsx";

export type SitesSort = "updated" | "trending" | "name";
export const SITES_PAGE_SIZE = 100;

function sortedSites(directory: Directory, sort: SitesSort) {
  if (sort === "name") return directory.byName;
  if (sort === "trending") {
    // Trending first, then the rest by recency
    const seen = new Set(directory.trending.map((s) => s.key));
    return [
      ...directory.trending,
      ...directory.recent.filter((s) => !seen.has(s.key)),
    ];
  }
  return directory.recent;
}

export function getSitesPageCount(directory: Directory): number {
  return Math.max(1, Math.ceil(directory.sites.size / SITES_PAGE_SIZE));
}

const SortLink: FC<{ sort: SitesSort; current: SitesSort; label: string }> = (
  { sort, current, label },
) => (
  <a
    href={sort === "updated" ? "/sites" : `/sites?sort=${sort}`}
    class={sort === current ? "cur" : undefined}
  >
    {label}
  </a>
);

export const SitesPage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  sort: SitesSort;
  page: number;
}> = ({ directory, gateway, sort, page }) => {
  const all = sortedSites(directory, sort);
  const pages = getSitesPageCount(directory);
  const start = (page - 1) * SITES_PAGE_SIZE;
  const rows = all.slice(start, start + SITES_PAGE_SIZE);
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (sort !== "updated") params.set("sort", sort);
    if (n > 1) params.set("page", String(n));
    const query = params.toString();
    return query ? `/sites?${query}` : "/sites";
  };

  return (
    <Layout
      title={`All sites · ${gateway.host}`}
      description={`All ${
        pluralize(directory.stats.sites, "website")
      } known to the ${gateway.host} nsite gateway.`}
    >
      <TopBar gateway={gateway} subtitle="all sites" />
      <p class="muted" style="margin-top:12px">
        {rows.length > 0
          ? `${start + 1}–${start + rows.length} of ${
            directory.stats.sites.toLocaleString("en-US")
          } sites`
          : "No sites known yet."}
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>
                <SortLink sort="name" current={sort} label="name" />
              </th>
              <th>author</th>
              <th>client</th>
              <th class="num">files</th>
              <th class="num">snaps</th>
              <th>
                <SortLink sort="trending" current={sort} label="7d visits" />
              </th>
              <th class="num">
                <SortLink
                  sort="updated"
                  current={sort}
                  label="modified (utc)"
                />
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <SiteRows
              sites={rows}
              directory={directory}
              gateway={gateway}
              showClient
              showSnapshots
              showStatus
            />
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav class="pager" aria-label="Pages">
          {page > 1 && <a href={pageHref(page - 1)}>← prev</a>}
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2)
            .map((n, i, list) => (
              <>
                {i > 0 && n - list[i - 1] > 1 && <span>…</span>}
                {n === page
                  ? <span>[{n}]</span>
                  : <a href={pageHref(n)}>{n}</a>}
              </>
            ))}
          {page < pages && <a href={pageHref(page + 1)}>next →</a>}
        </nav>
      )}
    </Layout>
  );
};

export const AuthorPage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  pubkey: string;
}> = ({ directory, gateway, pubkey }) => {
  const author = directory.authors.get(pubkey)!;
  const sites = author.siteKeys.map((key) => directory.sites.get(key)!);
  return (
    <Layout
      title={`${author.label} · ${gateway.host}`}
      description={`${pluralize(sites.length, "website")} by ${author.label}.`}
    >
      <TopBar
        gateway={gateway}
        chip={{ pubkey, label: author.label }}
        subtitle={
          <>
            {author.label} · {pluralize(sites.length, "site")} ·{" "}
            {pluralize(author.snapshotCount, "snapshot")}
          </>
        }
      />
      <p class="muted" style="margin-top:12px;overflow-wrap:anywhere">
        {author.npub}
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th class="num">files</th>
              <th class="num">snaps</th>
              <th>7d visits</th>
              <th class="num">modified (utc)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <SiteRows
              sites={sites}
              directory={directory}
              gateway={gateway}
              showAuthor={false}
              showSnapshots
              showStatus
            />
          </tbody>
        </table>
      </div>
    </Layout>
  );
};

export const AuthorNotFoundPage: FC<{ gateway: GatewayContext }> = (
  { gateway },
) => (
  <Layout title={`Author not found · ${gateway.host}`} noindex>
    <TopBar gateway={gateway} subtitle="author not found" />
    <p class="notice">
      This gateway doesn't list any sites by this author. Check the npub, or
      open their site directly with the address box.
    </p>
  </Layout>
);
