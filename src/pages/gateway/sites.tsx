import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../../helpers/directory.ts";
import { pluralize } from "../../helpers/format.ts";
import { type GatewayContext, SiteTable, TopBar } from "./components.tsx";
import { Layout } from "./layout.tsx";

export type SitesSort = "updated" | "trending" | "name";
const SITES_PAGE_SIZE = 100;

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

function sitesHref(sort: SitesSort, page = 1): string {
  const params = new URLSearchParams();
  if (sort !== "updated") params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/sites?${query}` : "/sites";
}

const SortLink: FC<{ sort: SitesSort; current: SitesSort; label: string }> = (
  { sort, current, label },
) => (
  <a href={sitesHref(sort)} class={sort === current ? "cur" : undefined}>
    {label}
  </a>
);

const Pager: FC<{ sort: SitesSort; page: number; pages: number }> = (
  { sort, page, pages },
) => (
  <nav class="pager" aria-label="Pages">
    {page > 1 && <a href={sitesHref(sort, page - 1)}>← prev</a>}
    {Array.from({ length: pages }, (_, i) => i + 1)
      .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2)
      .map((n, i, list) => (
        <>
          {i > 0 && n - list[i - 1] > 1 && <span>…</span>}
          {n === page
            ? <span>[{n}]</span>
            : <a href={sitesHref(sort, n)}>{n}</a>}
        </>
      ))}
    {page < pages && <a href={sitesHref(sort, page + 1)}>next →</a>}
  </nav>
);

export const SitesPage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  sort: SitesSort;
  page: number;
}> = ({ directory, gateway, sort, page }) => {
  const pages = getSitesPageCount(directory);
  const start = (page - 1) * SITES_PAGE_SIZE;
  const rows = sortedSites(directory, sort).slice(
    start,
    start + SITES_PAGE_SIZE,
  );

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
      <SiteTable
        sites={rows}
        directory={directory}
        gateway={gateway}
        columns={{ author: true, client: true, snapshots: true, status: true }}
        headers={{
          name: <SortLink sort="name" current={sort} label="name" />,
          visits: <SortLink sort="trending" current={sort} label="7d visits" />,
          modified: (
            <SortLink sort="updated" current={sort} label="modified (utc)" />
          ),
        }}
      />
      {pages > 1 && <Pager sort={sort} page={page} pages={pages} />}
    </Layout>
  );
};
