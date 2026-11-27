# Configuration

[README](../README.md) · [Deployment](deployment.md) · [Caching](caching.md)

Configuration comes from environment variables. Repository `start` and `dev`
tasks load `.env`; existing process environment values take precedence.

```sh
cp .env.example .env
```

Review the example before running: it supplies public relays, fallback Blossom
servers and a placeholder public domain. The tables below describe runtime
defaults when variables are unset, not the example file's values.

Docker needs explicit environment settings; see [deployment](deployment.md).
Restart the gateway after changing configuration.

## Server and directory

| Variable            | Default   | Description                                                |
| ------------------- | --------- | ---------------------------------------------------------- |
| `NSITE_HOST`        | `0.0.0.0` | Listener bind address                                      |
| `NSITE_PORT`        | `3000`    | Listener port                                              |
| `PUBLIC_DOMAIN`     | Unset     | Gateway root hostname and canonical URL domain             |
| `ONION_HOST`        | Unset     | Tor mirror URL; adds `Onion-Location` to nsite responses   |
| `CURATION_USER`     | Unset     | Curator public key (hex or npub)                           |
| `CURATION_REFRESH`  | `600`     | Curator mute-list refresh interval, seconds                |
| `DIRECTORY_REFRESH` | `600`     | Directory snapshot rebuild interval, seconds; minimum `10` |

When `CURATION_USER` is set, the gateway loads the user's NIP-51 mute list (kind
`10000`) into the event store and refreshes it independently of `NOSTR_RELAYS`.
Authors in public `p` tags are omitted from the homepage; encrypted mutes in
`content` are not applied.

For a Tor mirror:

```sh
ONION_HOST="http://examplehiddenservice.onion"
```

See [gateway pages](routing.md#gateway-pages) for directory behavior and
homepage customization.

## Relays and discovery

| Variable                      | Default                                    | Description                                                                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `LOOKUP_RELAYS`               | `wss://user.kindpag.es,wss://purplepag.es` | Comma-separated relays for NIP-65 relay lists (`10002`) and Blossom server lists (`10063`) |
| `NOSTR_RELAYS`                | None                                       | Supplemental relays for every event query and bulk site hydration                          |
| `RLEAY_SYNC_INTERVAL`         | `600`                                      | Reconciliation interval in seconds, or `live`                                              |
| `RELAY_SYNC_TIMEOUT`          | `120`                                      | Total hydration deadline in seconds, including capability checks and both event phases     |
| `RELAY_SYNC_PROGRESS_TIMEOUT` | `15`                                       | Per-relay stall timeout in seconds                                                         |
| `RELAY_SYNC_LOOKBACK`         | `0`                                        | Historical window in seconds; `0` loads all history                                        |
| `CACHE_RELAYS`                | Auto-detect `ws://localhost:4869`          | Comma-separated relays for event persistence                                               |
| `OUTBOXES_STALE_TIME`         | `3600`                                     | Publisher outbox refresh interval, seconds                                                 |
| `SERVERS_STALE_TIME`          | `3600`                                     | Publisher Blossom server-list refresh interval, seconds                                    |
| `PROFILES_STALE_TIME`         | `3600`                                     | Profile refresh interval, seconds                                                          |

`RLEAY_SYNC_INTERVAL` is intentionally documented with its current spelling: use
this exact environment variable name.

### Relay hydration

When `NOSTR_RELAYS` is set, startup loads manifests (`15128`, `35128`, `5128`)
and nsite-scoped deletions concurrently through Applesauce's sync loader. NIP-77
negentropy retrieves missing events where supported; paginated requests are the
fallback. Reconciliation includes older backfilled and same-second events rather
than advancing a shared timestamp cursor.

Periodic sync re-reads history on relays without NIP-77. Use
`RLEAY_SYNC_INTERVAL=live` for a persistent subscription instead. Live delivery
starts at the inclusive hydration boundary while historical loading runs,
avoiding a second unrestricted historical request. Hydration runs cannot overlap
and are cancelled on shutdown.

To cap each run at five minutes and load only the last 90 days:

```sh
RELAY_SYNC_TIMEOUT=300
RELAY_SYNC_PROGRESS_TIMEOUT=30
RELAY_SYNC_LOOKBACK=7776000
```

Timeouts must be positive whole seconds; lookback accepts non-negative whole
seconds. Invalid values fail startup. The inclusive window ends at each run's
start time and applies to manifests and deletions, not live subscriptions or
on-demand lookups. Older sites may be absent from the index; previously loaded
events are not evicted when the window moves.

Logs report duration, loading method and completion state per relay. Errored,
skipped or unpageable relays mean partial coverage. Public reads do not wait for
authentication; relays requiring it report errors. A stalled relay does not
discard healthy relays' results. At the total deadline, requests are cancelled
and already loaded events remain available. Later periodic runs retry; live mode
does not automatically retry incomplete historical hydration.

For loader comparisons, see the
[hydration benchmark](../CONTRIBUTING.md#relay-hydration-benchmark).

## Blossom

| Variable              | Default                              | Description                                                                                   |
| --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `BLOSSOM_SERVERS`     | None                                 | Comma-separated fallback servers when neither the manifest nor the publisher provides servers |
| `BLOSSOM_PROXY`       | Auto-detect `http://localhost:24242` | Upstream proxy checked first for blobs                                                        |
| `MAX_FILE_SIZE`       | `128 MiB`                            | Maximum blob size, checked against Content-Length and during streaming                        |
| `BLOB_SERVER_TTL`     | `604800`                             | Publisher-scoped preferred-source hint lifetime, seconds                                      |
| `BLOB_BAD_SOURCE_TTL` | `86400`                              | Bad `(publisher, sha256, server)` verification result lifetime, seconds                       |

### Blossom proxy

The proxy is checked before other servers. Requests include BUD-10 discovery
hints: `xs` parameters contain known server domains, and `as` contains the
author's public key.

```sh
BLOSSOM_PROXY="https://blossom-proxy.example.com"
```

```text
<BLOSSOM_PROXY>/<sha256>?xs=server1.com&xs=server2.com&as=<pubkey>
```

These hints let the proxy discover blobs it does not already cache. See
[BUD-11](https://github.com/hzrd149/blossom/pull/89) and the
[flower-cache implementation](https://github.com/hzrd149/flower-cache).
Preferred sources and proxies never bypass blob verification.

## Caches

| Variable                      | Default                  | Description                                                                                                                |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_PATH`                  | Deno default KV location | Persistent metadata database path, e.g. `./data/cache`                                                                     |
| `CACHE_TIME`                  | `3600`                   | General KV cache lifetime, seconds                                                                                         |
| `SITE_CACHE_MAX_AGE`          | `3600`                   | Browser/shared-cache freshness, non-negative integer seconds; `0` requires revalidation                                    |
| `SITE_LOADING_PAGE`           | `true`                   | Show browsers a temporary loading page while a cold site is fetched; `false` disables ([details](caching.md#loading-page)) |
| `BLOB_CACHE_DIR`              | `./data/blobs`           | Private owned directory; one process per directory                                                                         |
| `BLOB_CACHE_BYTES`            | `1073741824`             | Logical byte budget including active fill reservations (1 GiB)                                                             |
| `BLOB_CACHE_FILLS`            | `2`                      | Concurrent fills                                                                                                           |
| `BLOB_CACHE_PENDING`          | `512`                    | Queued distinct-hash fills, scheduled round-robin by publisher                                                             |
| `BLOB_CACHE_WAITERS`          | `1024`                   | Total cold waiting requests (including retiring jobs); also the separate warm reader queue capacity                        |
| `BLOB_CACHE_PER_FILL_WAITERS` | `32`                     | Cold requests per hash, including coalesced and retiring-job waiters                                                       |
| `BLOB_QUEUE_TIMEOUT_MS`       | `120000`                 | Maximum wait per queued fill, retiring-job wait or local reader admission (2 minutes)                                      |
| `BLOB_CACHE_SOURCES`          | `3`                      | Source attempts per fill                                                                                                   |
| `BLOB_CACHE_ENTRIES`          | `4096`                   | Completed-file LRU metadata entries                                                                                        |
| `BLOB_CACHE_READERS`          | `128`                    | Simultaneous local response streams                                                                                        |
| `BLOB_FILL_TIMEOUT_MS`        | `600000`                 | Whole active fill deadline across retries (10 minutes)                                                                     |
| `BLOB_STALL_TIMEOUT_MS`       | `30000`                  | Upstream inactivity and local response-consumption idle timeout                                                            |

Disk-cache counts, byte budget and timeouts must be positive integers.
`MAX_FILE_SIZE` must fit within `BLOB_CACHE_BYTES`; full configured concurrency
needs at least `MAX_FILE_SIZE * BLOB_CACHE_FILLS`.

## Stats

| Variable               | Default           | Description                                                        |
| ---------------------- | ----------------- | ------------------------------------------------------------------ |
| `STATS_PATH`           | `./data/stats.db` | SQLite database for analytics, trending and other persistent stats |
| `STATS_RETENTION_DAYS` | `90`              | Days of daily stats and serve-log records to keep; minimum `7`     |

Keep the stats database on a persistent volume separate from the caches
([details](caching.md#persistent-stats)).

See [caching and observability](caching.md) for storage ownership, failure
modes, HTTP semantics and logging. `VERIFY_WORKER_POOL_MAX` is obsolete; the
serve-first/background-verification path has been removed.
