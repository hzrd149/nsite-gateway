import type { FC } from "@hono/hono/jsx";
import type { Directory } from "../../helpers/directory.ts";
import { pluralize } from "../../helpers/format.ts";
import { Copy, type GatewayContext, SiteTable, TopBar } from "./components.tsx";
import { Layout } from "./layout.tsx";

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
      <p class="muted" style="margin-top:12px">
        <Copy>{author.npub}</Copy>
      </p>
      <SiteTable
        sites={sites}
        directory={directory}
        gateway={gateway}
        columns={{ snapshots: true, status: true }}
      />
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
      paste one of their site addresses into the search box.
    </p>
  </Layout>
);
