import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../../helpers/directory.ts";
import { pluralize } from "../../helpers/format.ts";
import { MAX_SITE_RESULTS, type SearchResults } from "../../helpers/search.ts";
import {
  AuthorItem,
  type GatewayContext,
  SiteTable,
  TopBar,
} from "./components.tsx";
import { Layout } from "./layout.tsx";

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
      <TopBar gateway={gateway} subtitle="search" query={query} />
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
              <AuthorItem
                key={author.pubkey}
                author={author}
                count={pluralize(author.siteKeys.length, "site")}
              />
            ))}
          </ul>
        </section>
      )}

      {sites.length > 0 && (
        <section>
          <h3>SITES</h3>
          <SiteTable
            sites={sites}
            directory={directory}
            gateway={gateway}
            columns={{ author: true, status: true }}
          />
        </section>
      )}
    </Layout>
  );
};
