import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../../helpers/directory.ts";
import { formatDateTime, pluralize } from "../../helpers/format.ts";
import {
  AuthorItem,
  type GatewayContext,
  SiteTable,
  TopBar,
} from "./components.tsx";
import { Layout } from "./layout.tsx";

export type HomeTab = "recent" | "trending";

const HOME_ROWS = 25;
const SOURCE_URL = "https://github.com/hzrd149/nsite-gateway";
const NPANEL_URL =
  "https://gitworkshop.dev/soapbox.pub/git.shakespeare.diy/npanel";

export const HomePage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  tab: HomeTab;
}> = ({ directory, gateway, tab }) => {
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
      <TopBar gateway={gateway} subtitle="Index of nostr websites" />
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
              <SiteTable
                sites={rows}
                directory={directory}
                gateway={gateway}
              />
            )}
        </div>
        <aside>
          <h3>FEATURED AUTHORS</h3>
          <ul>
            {directory.featuredAuthors.map((author) => (
              <AuthorItem key={author.pubkey} author={author} />
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
          <h3>RUN YOUR OWN GATEWAY</h3>
          <ul>
            <li>
              <a href={SOURCE_URL}>nsite-gateway</a>
              <span class="n">source</span>
            </li>
            <li>
              <a href={NPANEL_URL}>npanel</a>
              <span class="n">host chosen sites</span>
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
