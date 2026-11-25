# nsite-gateway

A Deno + Hono HTTP gateway for
[static websites published on Nostr](https://github.com/nostr-protocol/nips/blob/master/5A.md)
(the nsite protocol). It resolves site hostnames, discovers manifests on Nostr
relays, and serves SHA-256-verified files from
[Blossom](https://github.com/hzrd149/blossom).

## How it works

1. Resolve the request hostname to a root site (`15128`), named site (`35128`),
   or immutable snapshot (`5128`), including custom domains via CNAME.
2. Load the site's manifest through the publisher's outbox relays and configured
   supplemental relays, using Applesauce's in-memory event store.
3. Fetch missing blobs from Blossom, verify the complete content against the
   manifest hash, and cache verified bytes on disk before serving them.
4. Serve GET, HEAD, byte ranges, and conditional requests from verified files.

The gateway also provides a server-rendered site directory, search, author
pages, publisher diagnostics, and a JSON health endpoint. Deno KV stores
metadata and visit counts; an optional cache relay persists Nostr events across
restarts.

## Quick start

Use **Deno 2.9.8 or newer**, preferably the latest patched stable release.

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
cp .env.example .env
# Review .env for your relay, domain, and cache settings.
NSITE_HOST=127.0.0.1 deno task dev
```

Open <http://localhost:3000> for the directory or <http://localhost:3000/health>
for runtime status. Site requests use their own hostnames; see
[local site requests](CONTRIBUTING.md#local-site-requests).

## Codebase map

| Entry point                                                                  | Responsibility                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`main.ts`](main.ts)                                                         | Server startup, relay hydration, background services, shutdown |
| [`src/server.ts`](src/server.ts)                                             | Hono middleware and hostname-based routing                     |
| [`src/env.ts`](src/env.ts)                                                   | Environment configuration and defaults                         |
| [`src/routes/`](src/routes/)                                                 | Site serving and gateway page routes                           |
| [`src/services/nostr.ts`](src/services/nostr.ts)                             | Event store, relay discovery, manifest loading and sync        |
| [`src/services/dns.ts`](src/services/dns.ts)                                 | Hostname and CNAME resolution                                  |
| [`src/services/blossom.ts`](src/services/blossom.ts)                         | Blob source discovery and cache integration                    |
| [`src/services/verified-blob-cache.ts`](src/services/verified-blob-cache.ts) | Verified disk storage, admission limits and eviction           |
| [`src/services/`](src/services/)                                             | Metadata caching, directory, curation, analytics and telemetry |
| [`src/pages/`](src/pages/)                                                   | Server-rendered UI                                             |
| [`src/helpers/`](src/helpers/)                                               | Protocol, HTTP and lifecycle utilities                         |
| [`deno.json`](deno.json)                                                     | Tasks, named permissions and dependencies                      |

## Documentation

- [Configuration](docs/configuration.md): environment variables, relays,
  curation, Blossom proxies and cache settings.
- [Deployment](docs/deployment.md): Deno, JSR, Docker, Compose, DNS/TLS and
  network permission profiles.
- [Caching and observability](docs/caching.md): verification guarantees,
  resource limits, persistence, HTTP caching and request logs.
- [Routing and gateway pages](docs/routing.md): site addresses, endpoints,
  directory behavior and customization.
- [Contributing](CONTRIBUTING.md): development setup, checks, integration tests
  and change guidelines. Agents should also read [AGENTS.md](AGENTS.md).
- [Protocol reference](nsite.md) and [changelog](CHANGELOG.md).

## License

See [LICENSE](LICENSE).
