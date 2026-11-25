import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../helpers/directory.ts";
import { MAX_SITE_RESULTS, type SearchResults } from "../helpers/search.ts";
import { SiteRows } from "./home.tsx";
import {
  Chip,
  type GatewayContext,
  Layout,
  pluralize,
  TopBar,
} from "./layout.tsx";

export const SearchPage: FC<{
  directory: Directory;
  gateway: GatewayContext;
  results: SearchResults;
  notice?: string;
}> = ({ directory, gateway, results, notice }) => {
  const { sites, authors, query } = results;
  const empty = sites.length === 0 && authors.length === 0;

  return (
    <Layout title={`${query} · search · ${gateway.host}`} noindex>
      <TopBar gateway={gateway} subtitle="search" address={query} />
      {notice && <p class="error" role="alert">{notice}</p>}

      {empty
        ? (
          <div class="notice">
            <p>No sites or authors match "{query}".</p>
            <p class="muted" style="margin:0">
              Search matches site titles, identifiers, descriptions and author
              names this gateway already knows. To open a site that isn't
              listed, paste its npub, naddr or nsite URL.
            </p>
          </div>
        )
        : (
          <p class="muted" style="margin-top:12px">
            {results.moreSites
              ? `top ${MAX_SITE_RESULTS} sites`
              : pluralize(sites.length, "site")} and{" "}
            {pluralize(authors.length, "author")} matching "{query}"
          </p>
        )}

      {authors.length > 0 && (
        <section>
          <h3>AUTHORS</h3>
          <ul class="author-grid">
            {authors.map((author) => (
              <li key={author.pubkey}>
                <Chip pubkey={author.pubkey} label={author.label} />
                <a href={`/author/${author.npub}`}>{author.label}</a>
                <span class="n">
                  {pluralize(author.siteKeys.length, "site")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sites.length > 0 && (
        <section>
          <h3>SITES</h3>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>author</th>
                  <th class="num">files</th>
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
                  showStatus
                />
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Layout>
  );
};
