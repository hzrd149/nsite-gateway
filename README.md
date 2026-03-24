# nsite-gateway

A Deno + Hono gateway that serves [static websites published on Nostr](https://github.com/nostr-protocol/nips/pull/1538) (the nsite protocol).

Sites are identified by site manifest events (kind `15128` for root sites and kind `35128` for named sites) and blobs served via [Blossom](https://github.com/hzrd149/blossom).

## Configuring

All configuration is done through the `.env` file. Start by copying the example file and modifying it.

```sh
cp .env.example .env
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LOOKUP_RELAYS` | `wss://user.kindpag.es,wss://purplepag.es` | Comma-separated relays used to look up a user's NIP-65 relay list (kind `10002`) and blossom server list (kind `10063`) |
| `NOSTR_RELAYS` | _(none)_ | Extra relays added to every event query, supplemental to the user's own outbox relays |
| `CACHE_RELAYS` | _(auto-detect `ws://localhost:4869`)_ | Relays to persist all fetched events to (a local Nostr cache relay). Auto-detected if a relay is running on `localhost:4869` |
| `BLOSSOM_SERVERS` | _(none)_ | Comma-separated fallback blossom servers used when a user has no `10063` event and the manifest has no `server` tags |
| `BLOSSOM_PROXY` | _(auto-detect `http://localhost:24242`)_ | Optional upstream blossom proxy checked first for every blob (see [Blossom Proxy](#blossom-proxy)). Auto-detected if a proxy is running on `localhost:24242` |
| `MAX_FILE_SIZE` | `128 MB` | Maximum blob size to serve (e.g. `"2 MB"`). Enforced via `Content-Length` header and during streaming |
| `CACHE_PATH` | _(Deno default KV location)_ | File path for the persistent Deno KV store (e.g. `./data/cache`). Omit to use Deno's default location |
| `CACHE_TIME` | `3600` | TTL in seconds for all KV cache entries (DNS lookups, blob server hints) |
| `PUBLIC_DOMAIN` | _(none)_ | The gateway's own public domain. Used to distinguish root domain requests (homepage + status) from nsite subdomain requests |
| `NSITE_HOST` | `0.0.0.0` | IP address the server binds to |
| `NSITE_PORT` | `3000` | Port the server listens on |
| `ONION_HOST` | _(none)_ | If set to a `.onion` URL, every nsite response includes an `Onion-Location` header pointing to the Tor mirror |

## Running with Deno

```sh
deno task start
```

For local development with file watching:

```sh
deno task dev
```

The Deno tasks already include the required flags (`--unstable-kv`, `--env-file=.env`, and the necessary permission flags).

## Cache Backends

### Deno KV (metadata cache)

The gateway uses Deno KV to cache:

- **DNS resolution** results (hostname → pubkey + site identifier)
- **Blob server hints** — the last successful server for each blob (tried first on subsequent requests)
- **Blob server lists** — the full ordered server list for each blob

To enable persistent caching across restarts, set `CACHE_PATH`:

```sh
CACHE_PATH="./data/cache"
```

If `CACHE_PATH` is omitted, Deno uses its default local KV location (resets between restarts).

### Nostr Event Cache

All fetched Nostr events are held in an in-memory event store for the process lifetime. To persist events across restarts, point `CACHE_RELAYS` at a local Nostr relay:

```sh
CACHE_RELAYS="ws://localhost:4869"
```

If a relay is already running on `localhost:4869`, it will be detected and used automatically.

### HTTP Cache

All nsite responses include strong ETags (the blob's sha256 hash) and `Cache-Control: public, max-age=3600`. Conditional requests with `If-None-Match` are handled — matching ETags return `304 Not Modified` without fetching the blob at all.

## Running Directly from JSR

You can run the published package without cloning this repository:

```sh
deno run --unstable-kv --env-file=.env --allow-env --allow-net --allow-read --allow-write jsr:@hzrd149/nsite-gateway
```

## Running with Docker Compose

The included `docker-compose.yml` sets up a full production stack:

- **nsite-gateway** — the gateway itself
- **Caddy** — TLS termination and reverse proxy (requires a `Caddyfile`)
- **flower-cache** — local blossom proxy (wired as `BLOSSOM_PROXY`)

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
docker compose up
```

Persistent Deno KV caching is enabled via a Docker volume mounted at `/cache`.

Once running, the gateway is accessible at `http://localhost:3000`.

## Running with Docker

```sh
docker run --rm -it --name nsite -p 3000:3000 ghcr.io/hzrd149/nsite-gateway
```

> **Note:** To enable Deno KV caching in Docker, pass `--unstable-kv` via the `DENO_FLAGS` environment variable or use a custom entrypoint. The default image CMD does not include this flag.

## Hostname Resolution

The gateway resolves incoming hostnames to a Nostr site using three strategies (in order):

1. **npub subdomain** — `npub1abc....nsite.example.com`: the leftmost label is a valid bech32 `npub`, decoded to a hex pubkey. Serves the root site (kind `15128`).
2. **Named site label** — a 50-character base36-encoded pubkey followed by a 1–13 character site identifier (e.g. `<base36pubkey><identifier>.nsite.example.com`). Serves a named site (kind `35128`).
3. **CNAME resolution** — if the hostname doesn't parse directly as an nsite label, the gateway resolves CNAME records. This enables custom domains like `myblog.com → npub1abc....nsite.example.com`.

## Status Dashboard

The gateway serves a built-in status dashboard at `/status` on the gateway's own domain (`PUBLIC_DOMAIN`):

- **`GET /status`** — lists all site manifests currently loaded in the event store, with titles, authors, path counts, and last-updated timestamps.
- **`GET /status/:address`** — detailed view for any `npub`, `naddr`, `nprofile`, or raw hex pubkey: site metadata, relays, blossom servers, full path table with cached server info, and the raw manifest JSON.

Status pages are always `Cache-Control: no-store`.

## Onion Header

If you operate a Tor mirror, set `ONION_HOST` and the gateway will include an `Onion-Location` header in every nsite response:

```sh
ONION_HOST="http://examplehiddenservice.onion"
```

## Blossom Proxy

You can configure a `BLOSSOM_PROXY` server that will be checked first for all blob requests before falling back to other servers. When set, the gateway will:

1. Check the proxy first for each blob request
2. Include BUD-10 discovery hints as query parameters:
   - `xs` parameters: domain names of all known blossom servers (server hints)
   - `as` parameter: the author's pubkey (author hint)

This allows the proxy to locate blobs on other servers if it doesn't have them cached.

```sh
BLOSSOM_PROXY="https://blossom-proxy.example.com"
```

The proxy URL is constructed as:

```
<BLOSSOM_PROXY>/<sha256>?xs=server1.com&xs=server2.com&as=<pubkey>
```

The blossom proxy specification is defined in [BUD-11](https://github.com/hzrd149/blossom/pull/89). For a reference implementation, see [flower-cache](https://github.com/hzrd149/flower-cache).

If a proxy is already running on `localhost:24242`, it will be detected and used automatically without setting `BLOSSOM_PROXY`.
