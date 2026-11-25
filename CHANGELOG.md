# nsite-gateway

## Unreleased

### Minor Changes

- Redesign the gateway's own pages as lightweight, zero-JavaScript monospace
  pages. The homepage now explains nsites, offers a search box (`/search?q=`),
  and lists recently updated and trending sites with 7-day visit sparklines and
  featured authors. New `/sites` (paginated, sortable) and `/author/:npub` pages
  replace the old `/status` table, which now redirects to `/sites`.
- Render the homepage, site list and author pages from an in-memory directory
  snapshot rebuilt every `DIRECTORY_REFRESH` seconds (default 600), served with
  `ETag` and public caching. These requests no longer fetch profiles from
  relays.
- Make `/status/:address` cache-only: it never contacts relays or Blossom
  servers. It now shows the last result for each path the gateway served, the
  source server, bad-source marks for failing files, requested paths missing
  from the manifest, and the relays the manifest was seen on.
- Add `/health` (JSON) and a default `robots.txt` that keeps crawlers off
  `/status/` and `/search`.
- Link the gateway source and npanel (for hosting specific nsites) from the
  homepage sidebar.
- Show the author's name, npub and hex public key at the top of author pages.
- Load author profiles for the site list reliably: lookups now wait for the
  profile instead of returning the loader's placeholder, skip authors checked
  recently, and continue in batches after startup and each relay sync until
  every author has been looked up once.
- Search sites by title, identifier and description, and authors by name or npub
  prefix, from the in-memory directory without loading profiles. Pasting a site
  address into the search box opens the site directly.
- Make npubs, event ids, hashes, relay URLs and raw events on gateway pages
  select in full with a single click or double-click, even when they wrap.
- Count visits per day (kept 30 days) in addition to all-time totals. Counts are
  buffered in memory, and `HEAD` requests and known bot user agents are skipped.
- Show a temporary loading page when a browser opens a site page the gateway has
  not fetched yet. The manifest and file are fetched in the background, the
  page reports progress and reloads into the real site once it is ready, and a
  missing site or file shows the real error page after the reload. The loading
  page is sent as `503` with `Retry-After`, `Cache-Control: no-store` and
  `X-Robots-Tag: noindex` so nothing caches or indexes it; crawlers and scripts
  keep waiting for the real response. Set `SITE_LOADING_PAGE=false` to disable.
- Skip the author's Blossom server list lookup when the requested file is
  already verified on disk.

### Patch Changes

- Log cache metrics and service errors as compact single-line text, and attribute
  cache hits/misses/coalescing, verification strategy and streaming verification
  elapsed time to individual request paths without claiming shared hashing twice.
- Enable Deno's corrected disconnect-only request abort behavior; retain cache
  reader cleanup on EOF, cancellation, errors and timeouts.

- Retire cancelled disk-cache fills before admitting replacement requests for the
  same hash, avoiding retries joining an already-aborted fill.
- Bound discovery and source-hint callback waits by cancellation and deadlines,
  so stalled metadata operations cannot retain fill slots, reservations or pins
  indefinitely or prevent cache shutdown.
- Correct direct JSR permissions, cold conditional-request behavior and Docker
  cache documentation.

- Verify complete Blossom downloads with incremental SHA-256 in a bounded private
  disk cache before serving any bytes. Remove preferred-source exemptions and
  serve-first background verification; retain verified content across restarts.
- Serve GET, HEAD, single ranges and conditional ETags from local verified files,
  including cold requests, snapshots and custom 404s. Request identity encoding.
- Bound fill concurrency, FIFO queue, waiters, readers, source attempts, file
  metadata and disk reservations; return 503 with Retry-After on admission
  exhaustion. Add configurable fill/stall deadlines, LRU read pins, restart temp
  cleanup, exclusive directory locking and diagnostic metrics.
- Add verified cache configuration and local fixture tests; persist verified
  files in the Docker Compose cache volume. Replace VERIFY_WORKER_POOL_MAX with
  disk-cache limits.

- Bound each relay hydration run with a configurable total deadline
  (`RELAY_SYNC_TIMEOUT`, default 120 seconds) and per-relay progress timeout
  (`RELAY_SYNC_PROGRESS_TIMEOUT`, default 15 seconds). Keep events loaded before
  cancellation and report partial hydration.
- Add `RELAY_SYNC_LOOKBACK` to limit startup and periodic hydration to a rolling
  date window; default `0` retains full history. Validate settings at startup
  and support bounded-window comparisons in the hydration benchmark.
- Hydrate and periodically reconcile nsite manifests and deletions concurrently
  with Applesauce's NIP-77 sync loader and paginated fallback, including older
  backfills and same-second events. Report per-relay coverage and duration,
  avoid overlapping startup/periodic runs and duplicate live history requests,
  and cancel hydration on shutdown.
- Add a read-only public-relay hydration benchmark comparing the previous
  one-shot loader with the sync loader using fresh pools and stores.
- Include `wss://relay.ditto.pub` alongside Damus and Primal in the example
  relay configuration and hydration benchmark defaults.
- Isolate cached Blossom discovery URLs, proxy hints, preferred sources, and bad
  sources by manifest publisher, including snapshot requests and status pages.
  Legacy global source-cache entries are ignored.
- Validate manifest SHA-256 hashes and Blossom HTTP(S) URLs, including cached
  sources, to prevent local-file reads and URL overrides.
- Follow up to five Blossom redirects with URL validation at every hop and a
  shared timeout, preserving signed object-storage URLs and range requests.
- Add opt-in public IPv4 network restrictions with `start:public:ipv4`. This
  mode requires a public bind address, external IPv6 egress restrictions and
  public upstream services; default launch modes retain unrestricted network
  access.
- Recommend Deno 2.9.8 or newer for native resolved-IP network permission
  checks.
- Centralize gateway and test permissions as reusable named sets in `deno.json`,
  selected explicitly with `-P` by tasks or direct Deno commands.

## 3.6.7

### Patch Changes

- Add deployment-configurable site cache freshness with `SITE_CACHE_MAX_AGE`
- Require revalidation after cached site responses become stale
- Evaluate ETag conditions before range requests and use consistent
  Last-Modified headers
- Add unit coverage and GitHub and Nix CI test workflows
- Skip GHCR login and image pushes for fork pull requests

## 3.6.6

### Patch Changes

- Update the Docker base image to Deno 2.9.8
- Upgrade applesauce packages to v7 and refresh their dependencies
- Restore event expiration tracking with the upstream timer-clamping fix
- Update Hono

## 3.6.5

### Patch Changes

- Prefer path-derived MIME types over upstream Blossom `Content-Type` headers

## 3.6.4

### Patch Changes

- Disable event expiration tracking to prevent far-future NIP-40 expirations
  from causing a timer hot loop

## 3.6.3

### Patch Changes

- Skip hostname resolution for gateway root hosts

## 3.6.2

### Patch Changes

- Update nsyte link int 404 page

## 3.6.1

### Patch Changes

- Tighten host-server compliance with the updated nsite spec by returning 404
  for invalid unresolved hostnames, requiring manifest or kind `10063` blossom
  server hints, and forwarding blob `Content-Type` headers correctly

## 3.6.0

### Minor Changes

- Show the deploy client (e.g. nsyte) used to publish an nsite in status views,
  with links to known clients

## 3.5.1

### Patch Changes

- Sync kind 5 delete events during relay hydration and periodic nsite sync

## 3.5.0

### Minor Changes

- Add support for curation

### Patch Changes

- Pin applesauce version to v6

## 3.4.0

### Minor Changes

- Add support for site snapshots

## 3.3.0

### Minor Changes

- Verify blobs on after the first request

### Patch Changes

- Fix bug with fetching users profiles

## 3.2.1

### Patch Changes

- Fix css styles on error pages

## 3.2.0

### Minor Changes

- Add dark theme to pages
- Add basic hit counter for sites

### Patch Changes

- Fix requests taking 10+ seconds when unable to find blossom servers

## 3.1.0

### Minor Changes

- Periodically sync site manifests from NOSTR_RELAYS

## 3.0.0

### Major Changes

- Rewrite again, this time manually for less bugs and better performance
- Removed support for legacy `<name>.<npub>.gateway.net` subdomains
- Removed support for resolving TXT DNS records (unused)
- Removed support for hosting an nsite as the homepage
- Added status page for debugging

## 2.1.0

### Minor Changes

- Add ETag-based conditional requests for nsite content and local static files
- Return `304 Not Modified` for matching `If-None-Match` requests without
  fetching unchanged content

## 2.0.0

### Major Changes

- Rewrite the gateway to run on Deno and Hono
- Remove support for the legacy nsite file event kind `34128`

### Minor Changes

- Improve nsite hostname resolution for root and named sites
- Update Docker runtime and docs to use the Deno-native workflow

### Patch Changes

- Harden streaming and cache limits in the Deno server
- Fix site manifest event loading

## 1.4.2

### Patch Changes

- 15a9baa: Fix BLOSSOM_PROXY and CACHE_RELAYS variables being ignored

## 1.4.1

### Patch Changes

- d18cd81: Fix checking duplicate blossom servers for blobs

## 1.4.0

### Minor Changes

- 3b0d2f8: Auto detect local blossom and nostr cache servers
- 3b0d2f8: Add BLOSSOM_PROXY env for local blossom cache

## 1.3.0

### Minor Changes

- Support new site manifest kinds `15128` and `35128`

## 1.2.0

### Minor Changes

- 97518b1: Use `applesauce-relay` for relay connections
- 49ab586: Add incremental sync for pubkeys events

### Patch Changes

- 97518b1: Bump nostr-tools

## 1.1.1

### Patch Changes

- 100ff4c: Add more debug logging to blob streaming

## 1.1.0

### Minor Changes

- d45cf57: Support range requests

### Patch Changes

- 6f8b003: Remove unused dependencies

## 1.0.1

### Patch Changes

- 1473eee: Fix returning setup page when event can't be found for pubkey

## 1.0.0

### Major Changes

- ef5262f: Remove screenshots feature
- ef5262f: Remove nginx cache invalidations

### Minor Changes

- b37664b: Cleanup DNS pubkey resolution
- 9a04f63: Add support for resolving NIP-05 names on set domains
- b2b8e01: Make blossom requests in parallel

### Patch Changes

- ef5262f: Fix race condition when streaming blob

## 0.7.0

### Minor Changes

- 023e03e: Rename package to nsite-gateway

## 0.6.1

### Patch Changes

- 3747037: Add license file

## 0.6.0

### Minor Changes

- c84396e: Replace homepage with simple welcome page
- c84396e: Add option to download another nsite as a homepage
- 2ac847f: Add colors to logging

### Patch Changes

- 5be0822: Fix serving hidden files in .well-known

## 0.5.2

### Patch Changes

- 6704516: Fix package missing build folder

## 0.5.1

### Patch Changes

- ba71f35: bump dependnecies

## 0.5.0

### Minor Changes

- db172d4: Add support for custom 404.html pages

## 0.4.0

### Minor Changes

- 7c3c9c0: Add ONION_HOST env variable

## 0.3.0

### Minor Changes

- 145f89d: Add support for ALL_PROXY env variable
- f25e240: Add screenshots for nsites

### Patch Changes

- 87fecfc: Update landing page

## 0.2.0

### Minor Changes

- b7b43cf: Bundle nginx in docker image
- b7b43cf: Add NGINX_CACHE_DIR for invalidating nginx cache
- b7b43cf: Add SUBSCRIPTION_RELAYS for listening for new events

### Patch Changes

- 48ae388: Use users relays when searching for blossom servers

## 0.1.0

### Minor Changes

- bfc1b1c: Add simple landing page
- cd09700: Initial Release
