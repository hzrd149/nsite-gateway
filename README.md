# nsite-gateway

A Deno + Hono gateway that serves
[static websites published on Nostr](https://github.com/nostr-protocol/nips/blob/master/5A.md)
(the nsite protocol).

Sites are identified by site manifest events (kind `15128` for root sites, kind
`35128` for named sites, and kind `5128` for snapshots) and blobs served via
[Blossom](https://github.com/hzrd149/blossom).

## Configuring

All configuration is done through the `.env` file. Start by copying the example
file and modifying it.

```sh
cp .env.example .env
```

### Environment Variables

| Variable                 | Default                                    | Description                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LOOKUP_RELAYS`          | `wss://user.kindpag.es,wss://purplepag.es` | Comma-separated relays used to look up a user's NIP-65 relay list (kind `10002`) and blossom server list (kind `10063`)                                                                                                                                                                                                                                      |
| `NOSTR_RELAYS`           | _(none)_                                   | Extra relays added to every event query, supplemental to the user's own outbox relays                                                                                                                                                                                                                                                                        |
| `RLEAY_SYNC_INTERVAL`    | `600`                                      | How often to re-check `NOSTR_RELAYS` for newer site manifest and delete events, in seconds. Set to `live` to keep a persistent relay subscription open instead of periodic sync                                                                                                                                                                              |
| `CACHE_RELAYS`           | _(auto-detect `ws://localhost:4869`)_      | Relays to persist all fetched events to (a local Nostr cache relay). Auto-detected if a relay is running on `localhost:4869`                                                                                                                                                                                                                                 |
| `BLOSSOM_SERVERS`        | _(none)_                                   | Comma-separated fallback blossom servers used when a user has no `10063` event and the manifest has no `server` tags                                                                                                                                                                                                                                         |
| `BLOSSOM_PROXY`          | _(auto-detect `http://localhost:24242`)_   | Optional upstream blossom proxy checked first for every blob (see [Blossom Proxy](#blossom-proxy)). Auto-detected if a proxy is running on `localhost:24242`                                                                                                                                                                                                 |
| `MAX_FILE_SIZE`          | `128 MB`                                   | Maximum blob size to serve (e.g. `"2 MB"`). Enforced via `Content-Length` header and during streaming                                                                                                                                                                                                                                                        |
| `CACHE_PATH`             | _(Deno default KV location)_               | File path for the persistent Deno KV store (e.g. `./data/cache`). Omit to use Deno's default location                                                                                                                                                                                                                                                        |
| `CACHE_TIME`             | `3600`                                     | TTL in seconds for all KV cache entries (DNS lookups, blob server hints, user profiles)                                                                                                                                                                                                                                                                      |
| `BLOB_SERVER_TTL`        | `604800`                                   | TTL in seconds for the preferred verified blob source cache (`["blob-server", sha256]`), allowing trusted sources to stick around longer than general cache entries                                                                                                                                                                                          |
| `BLOB_BAD_SOURCE_TTL`    | `86400`                                    | TTL in seconds for a bad `(sha256, server)` verification result before that source is eligible to be retried for the blob                                                                                                                                                                                                                                    |
| `VERIFY_WORKER_POOL_MAX` | `4`                                        | Maximum number of blob verification workers created dynamically to hash responses in parallel                                                                                                                                                                                                                                                                |
| `PUBLIC_DOMAIN`          | _(none)_                                   | The gateway's own public domain. When set, it is used for constructing canonical site URLs on the homepage and status pages                                                                                                                                                                                                                                  |
| `NSITE_HOST`             | `0.0.0.0`                                  | IP address the server binds to                                                                                                                                                                                                                                                                                                                               |
| `NSITE_PORT`             | `3000`                                     | Port the server listens on                                                                                                                                                                                                                                                                                                                                   |
| `ONION_HOST`             | _(none)_                                   | If set to a `.onion` URL, every nsite response includes an `Onion-Location` header pointing to the Tor mirror                                                                                                                                                                                                                                                |
| `CURATION_USER`          | _(none)_                                   | Hex pubkey of a curator whose [NIP-51 mute list](https://github.com/nostr-protocol/nips/blob/master/51.md) (kind `10000`) is loaded into the in-memory event store at startup and refreshed on a timer. Sites whose author pubkey appears in **public** `p` tags on that list are omitted from the home page (encrypted mutes in `content` are not applied). |
| `CURATION_REFRESH`       | `600` (10 min)                             | How often to re-fetch the curator mute list, in seconds                                                                                                                                                                                                                                                                                                      |
| `DIRECTORY_REFRESH`      | `600` (10 min)                             | How often the homepage, site list and author pages are rebuilt, in seconds (minimum `10`)                                                                                                                                                                                                                                                                    |

## Running with Deno

Use **Deno 2.9.8 or newer**, preferably the latest patched stable release. This
is the minimum recommended version for this gateway's native network-deny
configuration. Deno 2.8.1 fixed the original `fetch()` resolved-IP permission
bypass
([advisory](https://github.com/denoland/deno/security/advisories/GHSA-cpgj-f7g3-2pp2));
our policy is tested on 2.9.8. Upgrading alone does not block private
destinations: network-deny rules must also be enabled.

```sh
deno task start
```

For local development with file watching:

```sh
deno task dev
```

The Deno tasks already include the required flags (`--unstable-kv`,
`--env-file=.env`, and a named permission set).

Permissions are defined once under `permissions` in `deno.json` and can be
reused by any task or direct invocation with `-P=<name>`:

```sh
deno run -P=gateway --unstable-kv --env-file=.env main.ts
deno test -P=test
```

The `gateway` set preserves access to internal services; `gateway-public-ipv4`
adds the destination restrictions described below. `test` grants only the unit
tests' environment access, while `test-network` grants access for the explicit
network integration suite. Permission sets require explicit `-P` selection;
merely running from the package directory does not activate them.

If `NOSTR_RELAYS` is set, the gateway will bulk-fetch all known site manifests
(kinds `15128`, `35128`, and `5128`) from those relays at startup,
pre-populating the in-memory event store, and then re-check those relays every
`RLEAY_SYNC_INTERVAL` seconds for newer manifest events. Set
`RLEAY_SYNC_INTERVAL=live` to keep a persistent relay subscription open instead
of using periodic sync.

### Public-network-only mode (IPv4 deployments)

**Prerequisite: disable IPv6 egress or block it at the network boundary.** Deno
2.9.8 accepts IPv4 subnet rules but rejects IPv6 subnet syntax in its CLI. The
profile below denies IPv6 loopback explicitly, but cannot block all private IPv6
ranges. It is not sufficient for dual-stack hosts without external IPv6
restrictions.

For an IPv4-only gateway that only needs public upstream services:

```sh
# Set NSITE_HOST in .env to a public IP assigned to this machine first.
deno task start:public:ipv4
# Or use the same permission set without a task:
deno run -P=gateway-public-ipv4 --no-prompt --unstable-kv --env-file=.env main.ts
```

This uses native `fetch()` with Deno's `--deny-net` subnet rules to block
private, loopback, link-local, multicast, documentation and other
special-purpose IPv4 destinations. Deno checks resolved IPs and connects using
those checked addresses, preventing DNS rebinding between validation and
connection. Native connection pooling, TLS verification and HTTP/2 are retained.
Blossom redirects still use the bounded manual redirect loop, so each hop is
subject to the runtime policy.

**Deployment constraints:**

- Network permissions apply to the entire process, including listeners, DNS
  operations, Nostr relays and configured proxies—not just Blossom.
- The default `NSITE_HOST=0.0.0.0`, private bind addresses and `::` are denied.
  Bind to an actual public IP assigned to the host. This mode is not a drop-in
  replacement for the included Docker Compose stack.
- Local cache-relay/proxy auto-detection will fail harmlessly. Explicit private
  `BLOSSOM_PROXY`, `BLOSSOM_SERVERS` and relay settings cannot be used in this
  mode. An `--allow-net` hostname cannot override a denied resolved IP.
- DNS operations requiring a denied local resolver may fail too; configure
  resolver access compatible with the policy.
- Do not route these requests through `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`
  or another forwarding proxy unless that proxy independently enforces the same
  destination policy. A proxy can resolve destinations differently.
- Flower fetches on behalf of publishers and needs its own outbound
  restrictions. The gateway's Deno permissions do not protect Flower.

The standard `start`/`dev` tasks, executable shebang, JSR command and default
Docker command still grant unrestricted network access for compatibility with
private services. **They do not provide private-network SSRF protection.** For
those deployments, enforce outbound policy at the network/proxy boundary or
isolate public fetching from trusted internal-service access. Do not weaken the
deny list merely to get a private service working.

The policy is in `deno.json` (`permissions.gateway-public-ipv4`), not in a task
command. To exercise native resolved-IP checks and redirects using local
fixtures, run `deno task test:network` in an isolated environment. This explicit
test task starts local listeners and child Deno processes; the regular unit-test
task does not need those permissions.

If `CURATION_USER` is set, the gateway loads that user's mute list via the same
event loader used elsewhere, keeps it in `eventStore`, and refreshes it on the
interval given by `CURATION_REFRESH` in seconds (independent of `NOSTR_RELAYS`).

## Cache Backends

### Deno KV (metadata cache)

The gateway uses Deno KV to cache:

- **DNS resolution** results (hostname → pubkey + site identifier)
- **Blob server hints** — the last successful server for each blob (tried first
  on subsequent requests)
- **Blob server lists** — the full ordered server list for each blob
- **User profiles** (kind `0`) — author display names shown on the homepage and
  status pages

To enable persistent caching, set `CACHE_PATH`:

```sh
CACHE_PATH="./data/cache"
```

If `CACHE_PATH` is omitted, Deno uses its default local KV location.

### Nostr Event Cache

All fetched Nostr events are held in an in-memory event store for the process
lifetime. To persist events across restarts, point `CACHE_RELAYS` at a local
Nostr relay:

```sh
CACHE_RELAYS="ws://localhost:4869"
```

If a relay is already running on `localhost:4869`, it will be detected and used
automatically.

### HTTP Cache

Served site files include strong ETags derived from the manifest's SHA-256 hash
for that file. Changed bytes produce a new ETag; republishing unchanged files
keeps the same ETag. Matching `If-None-Match` validators (including weak
validators and lists) return `304 Not Modified` without fetching the blob, for
GET and HEAD, including requests with Range. Custom 404 pages retain their 404
status. `Last-Modified` consistently uses the manifest publication time.

Set `SITE_CACHE_MAX_AGE` in the deployment environment to a non-negative integer
in seconds (default `3600`). Full and 304 responses both use
`Cache-Control: public, max-age=<value>, must-revalidate`. For sites that should
check for updates on every request, use:

```sh
SITE_CACHE_MAX_AGE=0
```

Browsers can still store files and reuse them after a successful ETag check.
Positive values allow reuse without checking until that many seconds have
passed. Restart the gateway after changing the setting. Previously cached
responses keep their original freshness lifetime until they expire or the
browser reloads them. This setting is independent of `CACHE_TIME` (server-side
caches) and does not change how quickly the gateway discovers new manifests from
Nostr relays (see `RLEAY_SYNC_INTERVAL`). ETags reflect the manifest currently
known to the gateway.

## Running Directly from JSR

You can run the published package without cloning this repository:

```sh
deno run --unstable-kv --env-file=.env --allow-env --allow-net --allow-read --allow-write jsr:@hzrd149/nsite-gateway
```

## Running with Docker Compose

The included `docker-compose.yml` sets up a full production stack:

- **nsite-gateway** — the gateway itself
- **Caddy** — TLS termination and reverse proxy
- **flower-cache** — local blossom proxy (wired as `BLOSSOM_PROXY`)

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
docker compose up
```

Persistent Deno KV caching is enabled via a Docker volume mounted at `/cache`.

> **Note:** You must create a `Caddyfile` before starting the stack — the
> `docker-compose.yml` mounts `./Caddyfile` into the Caddy container but the
> file is not included in the repository.

Once running, the gateway is accessible at `http://localhost:3000`.

## Running with Docker

```sh
docker run --rm -it --name nsite -p 3000:3000 ghcr.io/hzrd149/nsite-gateway
```

> **Note:** The default image CMD does not include `--unstable-kv` or
> `--allow-write`, so Deno KV caching is inactive. Use a custom entrypoint or
> the `docker compose` setup if you need persistent caching.

## Hostname Resolution

The gateway resolves incoming hostnames to a Nostr site using three strategies
(in order):

1. **npub subdomain** — `npub1abc....nsite.example.com`: the leftmost label is a
   valid bech32 `npub`, decoded to a hex pubkey. Serves the root site (kind
   `15128`).
2. **Snapshot label** — `v<50-char-base36-event-id>.nsite.example.com`: the
   leftmost label starts with `v` and is followed by a 50-character base36
   snapshot event id. Serves the exact snapshot event (kind `5128`).
3. **Named site label** — a 50-character base36-encoded pubkey followed by a
   1–13 character site identifier (e.g.
   `<base36pubkey><identifier>.nsite.example.com`). Serves a named site (kind
   `35128`).
4. **CNAME resolution** — if the hostname doesn't parse directly as an nsite
   label, the gateway resolves CNAME records. This enables custom domains like
   `myblog.com → npub1abc....nsite.example.com`.

## Gateway Pages

The root domain serves a small set of server-rendered pages with no JavaScript
and no remote images. Pages that list sites are rendered from an in-memory
directory snapshot that is rebuilt every `DIRECTORY_REFRESH` seconds, so
requests never wait on relays or Blossom servers. They are served with an `ETag`
and `Cache-Control: public, max-age=<DIRECTORY_REFRESH>`.

- **`GET /`**: explains nsites, offers a search box, and lists recently updated
  or trending (`?tab=trending`) sites with 7-day visit sparklines and featured
  authors.
- **`GET /search?q=<query>`**: searches the in-memory directory by site title,
  identifier, description and author name, or by npub prefix for authors. Author
  names come only from profiles the gateway already has; searching never loads
  profiles or contacts relays. Queries are truncated to 64 characters and 6
  words, results are capped (50 sites, 20 authors), and result pages are cached
  per query in their own bounded cache. A pasted `npub`, `naddr`, `nevent`,
  `nprofile`, hex pubkey or nsite URL redirects straight to the site's
  subdomain. NIP-05 names are not supported.
- **`GET /sites?sort=updated|trending|name&page=N`**: paginated table of every
  known site.
- **`GET /author/:npub`**: sites published by one author.
- **`GET /status/:address`**: debugging page for publishers. It shows the
  manifest, the relays it was seen on, Blossom servers, the last result for each
  path this gateway served (with bad-source marks for failing files), requested
  paths missing from the manifest, snapshots and the raw event. It only reads
  data the gateway already has and never contacts relays or Blossom servers; a
  site that hasn't been visited yet shows a short "not seen yet" page. Status
  pages send `noindex`.
- **`GET /status`**: redirects to `/sites`.
- **`GET /health`**: JSON with version, uptime, site counts, relay connections,
  last relay sync and verifier pool stats.
- **`GET /robots.txt`**: disallows `/status/` and `/search` unless
  `public/robots.txt` exists.

Visits are counted for `.html` page views only. `HEAD` requests and known bot or
script user agents are skipped. Counts are buffered in memory and written to KV
every 30 seconds as all-time totals and daily buckets kept for 30 days.

To replace the built-in homepage with your own, place an `index.html` file in
the `public/` directory at the project root.

## Onion Header

If you operate a Tor mirror, set `ONION_HOST` and the gateway will include an
`Onion-Location` header in every nsite response:

```sh
ONION_HOST="http://examplehiddenservice.onion"
```

## Blossom Proxy

You can configure a `BLOSSOM_PROXY` server that will be checked first for all
blob requests before falling back to other servers. When set, the gateway will:

1. Check the proxy first for each blob request
2. Include BUD-10 discovery hints as query parameters:
   - `xs` parameters: domain names of all known blossom servers (server hints)
   - `as` parameter: the author's pubkey (author hint)

This allows the proxy to locate blobs on other servers if it doesn't have them
cached.

```sh
BLOSSOM_PROXY="https://blossom-proxy.example.com"
```

The proxy URL is constructed as:

```
<BLOSSOM_PROXY>/<sha256>?xs=server1.com&xs=server2.com&as=<pubkey>
```

The blossom proxy specification is defined in
[BUD-11](https://github.com/hzrd149/blossom/pull/89). For a reference
implementation, see [flower-cache](https://github.com/hzrd149/flower-cache).

If a proxy is already running on `localhost:24242`, it will be detected and used
automatically without setting `BLOSSOM_PROXY`.
