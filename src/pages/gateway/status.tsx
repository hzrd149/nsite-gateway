import type { Child, FC } from "@hono/hono/jsx";
import {
  formatAgeFromUnix,
  formatCount,
  formatDateTime,
  shortId,
} from "../../helpers/format.ts";
import type { ResolvedSiteAddress } from "../../helpers/resolved-site.ts";
import type { NsiteDeployClientReference } from "../../nsite-clients.ts";
import type { ServeRecord } from "../../services/site-telemetry.ts";
import { Chip, Copy, type GatewayContext, Spark } from "./components.tsx";
import { Layout } from "./layout.tsx";

export type StatusPath = {
  path: string;
  sha256: string;
  record?: ServeRecord;
  badSources: { host: string; reason: string; expiresAt: number }[];
};

export type StatusSnapshot = {
  id: string;
  label: string;
  pathCount: number;
  createdAt: number;
  href?: string;
  statusPath: string;
  matchesCurrent: boolean;
};

export type SiteStatusData = {
  gateway: GatewayContext;
  address: string;
  kind: number;
  isSnapshot: boolean;
  identifier: string;
  label: string;
  title?: string;
  description?: string;
  siteUrl?: string;
  source?: string;
  client?: NsiteDeployClientReference;
  createdAt: number;
  eventId: string;
  author: { pubkey: string; npub: string; label: string; listed: boolean };
  parent?: { label: string; statusPath: string };
  seenRelays: string[];
  manifestRelays: string[];
  lastRelaySync?: number;
  manifestServers: string[];
  userServers?: string[];
  fallbackServers: string[];
  hits: { allTime: number; daily: number[] };
  paths: StatusPath[];
  /** Paths requested but missing from the manifest */
  missing: { path: string; record: ServeRecord }[];
  snapshots: StatusSnapshot[];
  raw: string;
};

const Head: FC<{ left: string; mid: Child; right: string }> = (p) => (
  <div class="head">
    <span>{p.left}</span>
    <span>{p.mid}</span>
    <span>{p.right}</span>
  </div>
);

const Section: FC<{ title: string; children: Child }> = (
  { title, children },
) => (
  <section>
    <h2>{title}</h2>
    <div class="indent">{children}</div>
  </section>
);

function ago(unixMs: number): string {
  return `${formatAgeFromUnix(Math.floor(unixMs / 1000))} ago`;
}

const ResultCell: FC<{ record?: ServeRecord }> = ({ record }) => {
  if (!record) return <span class="muted">not requested yet</span>;
  switch (record.r) {
    case "served":
      return <span class="ok">{record.s} served</span>;
    case "path-not-found":
      return <span class="warn">{record.s} not in manifest</span>;
    case "unavailable":
      return <span class="bad">{record.s} no server returned the file</span>;
  }
};

/** Relay URLs, each copyable on its own */
const RelayList: FC<{ relays: string[] }> = ({ relays }) => (
  <>
    {relays.map((relay, i) => (
      <>
        {i > 0 && ", "}
        <Copy>{relay}</Copy>
      </>
    ))}
  </>
);

const ServerList: FC<{ servers?: string[]; empty: string }> = (
  { servers, empty },
) =>
  servers && servers.length > 0
    ? (
      <ul>
        {servers.map((s) => (
          <li key={s}>
            <a href={s} rel="nofollow">{s}</a>
          </li>
        ))}
      </ul>
    )
    : <span class="muted">{empty}</span>;

export const SiteStatusPage: FC<{ data: SiteStatusData }> = ({ data }) => {
  const served = data.paths.filter((p) => p.record?.r === "served").length;
  const failing =
    data.paths.filter((p) => p.record && p.record.r !== "served").length;
  const untouched = data.paths.length - served - failing;
  const manPage = data.isSnapshot ? "SNAPSHOT(8)" : "STATUS(8)";

  return (
    <Layout
      title={`${data.label} · status`}
      class="man"
      noindex
    >
      <Head
        left={manPage}
        mid={<a href="/">{data.gateway.host}</a>}
        right={manPage}
      />

      <Section title="NAME">
        {data.siteUrl ? <a href={data.siteUrl}>{data.label}</a> : data.label}
        {data.description && <>· {data.description}</>}
      </Section>

      <Section title="SYNOPSIS">
        <dl>
          <dt>url</dt>
          <dd>
            {data.siteUrl
              ? <a href={data.siteUrl}>{data.siteUrl}</a>
              : (
                <span class="muted">
                  not addressable as a subdomain (identifier is not canonical)
                </span>
              )}
          </dd>
          <dt>address</dt>
          <dd>
            <Copy>{data.address}</Copy>
          </dd>
          {data.parent && (
            <>
              <dt>snapshot of</dt>
              <dd>
                <a href={data.parent.statusPath}>{data.parent.label}</a>
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title="AUTHOR">
        <div style="display:flex;gap:10px;align-items:center">
          <Chip pubkey={data.author.pubkey} label={data.author.label} />
          {data.author.listed
            ? <a href={`/author/${data.author.npub}`}>{data.author.label}</a>
            : data.author.label}
        </div>
        <div class="muted">
          <Copy>{data.author.npub}</Copy>
        </div>
      </Section>

      <Section title="MANIFEST">
        <dl>
          <dt>kind</dt>
          <dd>
            {data.kind}{" "}
            <span class="muted">
              {data.isSnapshot
                ? "(snapshot)"
                : data.identifier
                ? `(named site "${data.identifier}")`
                : "(root site)"}
            </span>
          </dd>
          <dt>published</dt>
          <dd>
            {formatDateTime(data.createdAt)} UTC{" "}
            <span class="muted">({ago(data.createdAt * 1000)})</span>
          </dd>
          <dt>event id</dt>
          <dd>
            <Copy>{data.eventId}</Copy>
          </dd>
          <dt>files</dt>
          <dd>{data.paths.length}</dd>
          {data.client && (
            <>
              <dt>client</dt>
              <dd>
                {data.client.href
                  ? <a href={data.client.href}>{data.client.name}</a>
                  : data.client.name}
              </dd>
            </>
          )}
          {data.source && (
            <>
              <dt>source</dt>
              <dd>
                <a href={data.source} rel="nofollow">{data.source}</a>
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title="PROVENANCE">
        <dl>
          <dt>seen on</dt>
          <dd>
            {data.seenRelays.length > 0
              ? <RelayList relays={data.seenRelays} />
              : <span class="muted">unknown (loaded from cache)</span>}
          </dd>
          <dt>relay hints</dt>
          <dd>
            {data.manifestRelays.length > 0
              ? <RelayList relays={data.manifestRelays} />
              : <span class="muted">none in manifest</span>}
          </dd>
          <dt>last sync</dt>
          <dd>
            {data.lastRelaySync
              ? ago(data.lastRelaySync)
              : <span class="muted">no relay sync configured</span>}
          </dd>
        </dl>
      </Section>

      <Section title="BLOSSOM SERVERS">
        <dl>
          <dt>manifest</dt>
          <dd>
            <ServerList servers={data.manifestServers} empty="none listed" />
          </dd>
          <dt>author list</dt>
          <dd>
            <ServerList
              servers={data.userServers}
              empty={data.userServers
                ? "empty"
                : "not loaded yet (fetched when the site is visited)"}
            />
          </dd>
          {data.fallbackServers.length > 0 && (
            <>
              <dt>gateway</dt>
              <dd>
                <ServerList servers={data.fallbackServers} empty="" />
              </dd>
            </>
          )}
        </dl>
      </Section>

      {!data.isSnapshot && (
        <Section title="ACTIVITY">
          <Spark values={data.hits.daily} />{" "}
          {formatCount(data.hits.daily.reduce((a, b) => a + b, 0))}{" "}
          visits in 7 days · {formatCount(data.hits.allTime)} all time{" "}
          <span class="muted">(page views, bots excluded)</span>
        </Section>
      )}

      <Section title="FILES">
        <p>
          <span class="ok">{served} served</span> ·{" "}
          <span class={failing ? "bad" : "muted"}>{failing} failing</span> ·
          {" "}
          <span class="muted">{untouched} not requested yet</span>
        </p>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>path</th>
                <th>sha256</th>
                <th>last result</th>
                <th>server</th>
                <th class="num">when</th>
              </tr>
            </thead>
            <tbody>
              {data.paths.map((p) => (
                <tr key={p.path}>
                  <td>
                    {data.siteUrl
                      ? (
                        <a href={data.siteUrl.replace(/\/$/, "") + p.path}>
                          {p.path}
                        </a>
                      )
                      : p.path}
                  </td>
                  <td>
                    <Copy class="hash" title={p.sha256}>{p.sha256}</Copy>
                  </td>
                  <td>
                    <ResultCell record={p.record} />
                  </td>
                  <td>
                    {p.record?.h ??
                      (p.record?.r === "served" ? "disk cache" : "")}
                    {p.badSources.map((b) => (
                      <div class="bad" key={b.host}>
                        {b.host}: {b.reason.replaceAll("_", " ")}, retry in{" "}
                        {formatAgeFromUnix(0, b.expiresAt - Date.now())}
                      </div>
                    ))}
                  </td>
                  <td class="num">{p.record ? ago(p.record.t) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {data.missing.length > 0 && (
        <Section title="MISSING PATHS">
          <p class="muted">
            Visitors requested these paths, but they are not in the manifest.
          </p>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>path</th>
                  <th>result</th>
                  <th class="num">when</th>
                </tr>
              </thead>
              <tbody>
                {data.missing.map((m) => (
                  <tr key={m.path}>
                    <td>{m.path}</td>
                    <td>
                      <ResultCell record={m.record} />
                    </td>
                    <td class="num">{ago(m.record.t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {data.snapshots.length > 0 && (
        <Section title={`SNAPSHOTS (${data.snapshots.length})`}>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>snapshot</th>
                  <th class="num">files</th>
                  <th class="num">published (utc)</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{s.href ? <a href={s.href}>{s.label}</a> : s.label}</td>
                    <td class="num">{s.pathCount}</td>
                    <td class="num">{formatDateTime(s.createdAt)}</td>
                    <td>
                      <a href={s.statusPath}>status</a>
                    </td>
                    <td class="muted">
                      {s.matchesCurrent ? "same files as current" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="RAW EVENT">
        <details>
          <summary>
            kind {data.kind} · id {shortId(data.eventId, 12)}…
          </summary>
          <pre class="copy">{data.raw}</pre>
        </details>
      </Section>

      <Section title="SEE ALSO">
        <a href="/sites">sites</a>, {data.author.listed && (
          <>
            <a href={`/author/${data.author.npub}`}>author</a>,{" "}
          </>
        )}
        <a href="/health">health</a>,{" "}
        <a href="https://github.com/nostr-protocol/nips/blob/master/5A.md">
          NIP-5A
        </a>
      </Section>

      <Head
        left="cached data only"
        mid={`generated ${formatDateTime(Date.now() / 1000)} UTC`}
        right={manPage}
      />
    </Layout>
  );
};

export const SiteUnknownPage: FC<{
  gateway: GatewayContext;
  address: string;
  parsed?: ResolvedSiteAddress;
  siteUrl?: string;
}> = ({ gateway, address, parsed, siteUrl }) => (
  <Layout title="Site not loaded · status" class="man" noindex>
    <Head
      left="STATUS(8)"
      mid={<a href="/">{gateway.host}</a>}
      right="STATUS(8)"
    />
    {parsed
      ? (
        <>
          <Section title="NAME">
            Not seen by this gateway yet
          </Section>
          <Section title="DESCRIPTION">
            Status pages only show data the gateway already has, so loading this
            page never contacts relays or Blossom servers. {siteUrl
              ? (
                <>
                  Open <a href={siteUrl}>the site</a>{" "}
                  once to load its manifest, then reload this page.
                </>
              )
              : "Visit the site once to load its manifest, then reload this page."}
          </Section>
          <Section title="PARSED AS">
            <dl>
              {parsed.type === "snapshot"
                ? (
                  <>
                    <dt>snapshot</dt>
                    <dd>
                      <Copy>{parsed.id}</Copy>
                    </dd>
                  </>
                )
                : (
                  <>
                    <dt>kind</dt>
                    <dd>{parsed.kind}</dd>
                    <dt>pubkey</dt>
                    <dd>
                      <Copy>{parsed.pubkey}</Copy>
                    </dd>
                    <dt>identifier</dt>
                    <dd>{parsed.identifier || "(root site)"}</dd>
                  </>
                )}
            </dl>
          </Section>
        </>
      )
      : (
        <>
          <Section title="NAME">Invalid address</Section>
          <Section title="DESCRIPTION">
            Could not read <code>{address}</code>{" "}
            as an npub, naddr, nevent, nprofile, hex pubkey or gateway URL.
          </Section>
        </>
      )}
  </Layout>
);
