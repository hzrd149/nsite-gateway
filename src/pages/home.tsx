import type { FC } from "@hono/hono/jsx";
import type { Directory, DirectorySite } from "../helpers/directory.ts";
import {
  Age,
  AuthorLink,
  Chip,
  formatCount,
  formatDateTime,
  type GatewayContext,
  Layout,
  pluralize,
  SiteName,
  Spark,
  TopBar,
} from "./layout.tsx";

export type HomeTab = "recent" | "trending";

const HOME_ROWS = 25;

export const SiteRows: FC<{
  sites: DirectorySite[];
  directory: Directory;
  gateway: GatewayContext;
  showAuthor?: boolean;
  showStatus?: boolean;
  showSnapshots?: boolean;
  showClient?: boolean;
}> = ({ sites, directory, gateway, ...show }) => (
  <>
    {sites.map((site) => (
      <tr key={site.key}>
        <td class="wrap">
          <SiteName site={site} gateway={gateway} />
          {site.description && <span class="desc">{site.description}</span>}
        </td>
        {show.showAuthor !== false && (
          <td>
            <AuthorLink
              author={directory.authors.get(site.pubkey)}
              pubkey={site.pubkey}
            />
          </td>
        )}
        {show.showClient && (
          <td>
            {site.client
              ? site.client.href
                ? <a href={site.client.href}>{site.client.name}</a>
                : site.client.name
              : <span class="muted">—</span>}
          </td>
        )}
        <td class="num">{site.pathCount}</td>
        {show.showSnapshots && (
          <td class="num">
            {site.latestSnapshotStatus
              ? <a href={site.latestSnapshotStatus}>{site.snapshotCount}</a>
              : site.snapshotCount}
          </td>
        )}
        <td>
          <Spark values={site.dailyHits} />{" "}
          <span class="num">{formatCount(site.recentHits)}</span>
        </td>
        <td class="num">
          <Age unix={site.updatedAt} />
        </td>
        {show.showStatus && (
          <td>
            <a href={site.statusPath}>status</a>
          </td>
        )}
      </tr>
    ))}
  </>
);

export const HomePage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  tab: HomeTab;
  error?: string;
  address?: string;
}> = ({ directory, gateway, tab, error, address }) => {
  const list = tab === "trending" ? directory.trending : directory.recent;
  const rows = list.slice(0, HOME_ROWS);
  const { stats } = directory;

  return (
    <Layout
      title={`${gateway.host} · nsite gateway`}
      description={`Index of ${
        pluralize(stats.sites, "website")
      } published on Nostr and served through ${gateway.host}.`}
    >
      <TopBar
        gateway={gateway}
        subtitle="Index of nostr websites"
        address={address}
      />
      {error && <p class="error" role="alert">{error}</p>}
      <div class="cols">
        <div style="min-width:0">
          <nav class="tabs" aria-label="Site lists">
            {tab === "recent"
              ? <span class="cur">recent</span>
              : <a href="/">recent</a>}
            {tab === "trending"
              ? <span class="cur">trending</span>
              : <a href="/?tab=trending">trending</a>}
            <a class="end" href="/sites">
              all {stats.sites.toLocaleString("en-US")} →
            </a>
          </nav>
          {rows.length === 0
            ? (
              <p class="muted">
                {tab === "trending"
                  ? "No visits recorded in the last 7 days yet."
                  : "No sites known yet. Sites appear here as the gateway syncs them from relays or serves them."}
              </p>
            )
            : (
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>author</th>
                      <th class="num">files</th>
                      <th>7d visits</th>
                      <th class="num">modified (utc)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SiteRows
                      sites={rows}
                      directory={directory}
                      gateway={gateway}
                    />
                  </tbody>
                </table>
              </div>
            )}
        </div>
        <aside>
          <h3>FEATURED AUTHORS</h3>
          <ul>
            {directory.featuredAuthors.map((author) => (
              <li key={author.pubkey}>
                <Chip pubkey={author.pubkey} label={author.label} />
                <a href={`/author/${author.npub}`}>{author.label}</a>
                <span class="n">{author.siteKeys.length}</span>
              </li>
            ))}
          </ul>
          <h3>PUBLISH YOUR OWN</h3>
          <ul>
            <li>
              <a href="https://nsite.run/">nsite.run</a>
              <span class="n">in the browser</span>
            </li>
            <li>
              <a href="https://nsyte.run/">nsyte</a>
              <span class="n">command line</span>
            </li>
          </ul>
        </aside>
      </div>
      <p class="about">
        An nsite is a static website whose file list is a signed Nostr event.
        The files are stored on Blossom servers by their sha256 hash. This
        gateway serves{" "}
        <code>&lt;npub&gt;.{gateway.host}</code>: it finds the site's manifest,
        fetches each file from the author's servers and checks its hash before
        serving it. {pluralize(stats.sites, "site")} ·{" "}
        {pluralize(stats.authors, "author")} ·{" "}
        {pluralize(stats.snapshots, "snapshot")} · list built{" "}
        {formatDateTime(directory.builtAt / 1000)} UTC ·{" "}
        <a href="/health">health</a>
      </p>
    </Layout>
  );
};
