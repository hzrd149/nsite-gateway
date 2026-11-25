# Caching and observability

[README](../README.md) · [Configuration](configuration.md#caches) ·
[Deployment](deployment.md)

## Verified disk cache

Every cold request downloads the complete blob to a unique private temporary
file, incrementally hashes it, and atomically promotes it only after SHA-256
matches the manifest. No upstream bytes are served before verification,
including for HEAD, ranges and matching conditional requests. Preferred sources
are only ordering hints. Verified content is shared by hash; discovery,
bad-source and preferred-source state remain publisher-scoped. A failed
publisher's fill cannot permanently poison another publisher's retry.

GET, HEAD, single byte ranges, strong ETags, weak `If-None-Match` comparisons
and strong `If-Range` work from verified local files. Unsupported/multipart
ranges are ignored; unsatisfiable single ranges return 416. HEAD ignores Range.
Custom 404s use the complete verified 404 file with status 404. Source requests
use GET with `Accept-Encoding: identity`; explicitly encoded upstream responses
are rejected. Response lengths come from the verified file, not upstream
headers. Unknown-extension files use `application/octet-stream`.

### Admission and capacity

Fill dispatch is round-robin across publishers with queued work, FIFO within
each publisher, independent of client IP or forwarded headers. Shared hashes
occupy one job attributed to its creating publisher. Each
active fill reserves `MAX_FILE_SIZE` bytes before contacting sources, so even
unknown-length streams cannot exceed the logical-byte quota. `MAX_FILE_SIZE`
must fit inside `BLOB_CACHE_BYTES`; full configured concurrency requires at
least `MAX_FILE_SIZE * BLOB_CACHE_FILLS`. Queued fills reserve no disk.
Active fills are not preempted, so large fills can delay small cold requests.
For large artifacts, increase both
the quota and whole-fill timeout as needed.

Discovery and source-hint waits respect cancellation and the whole-fill
deadline. Best-effort hint persistence also has a `BLOB_STALL_TIMEOUT_MS`
deadline; late callback settlement cannot resume a retired fill. An already
submitted KV operation may complete, but cancellation checks prevent subsequent
hint writes. Replacement requests for an aborted hash wait for disk cleanup
before a new fill.

Defaults allow 512 queued hashes and 1024 cold waiting requests, with a separate
32-request per-hash cap that also covers requests waiting for aborted-fill
cleanup. Last-waiter cancellation removes queued jobs immediately. Queued fills
expire after `BLOB_QUEUE_TIMEOUT_MS` (120 seconds); their active-fill deadline
starts only on dispatch. Retiring-job waits have the same queue deadline.

Warm GETs wait FIFO for a reader slot instead of rejecting a normal preload
burst. At most 128 local streams are active; a separate queue holds at most 1024
requests with the same queue deadline. Waiting readers pin verified files but
open no files. HEAD/304 responses need no reader slot. Abort, timeout and shutdown
release admission; stalled active streams retain the existing idle timeout.

The local fixture suite covers 217 distinct cold dependencies with three
concurrent visitors and two competing publishers, plus 217 simultaneous warm
reads (`deno task test:verified-cache`). This is burst capacity, not a throughput
guarantee: two active fills must drain the queue within its deadline, and pinned
files plus active reservations must fit the quota. A full queue can reject new
publishers; round-robin fairness applies to admitted work, not reserved admission
per identity. Increase timeouts only for intentionally longer waits.

Full queues, exhausted waiter limits, queue deadlines and unavailable disk reservations return
503 with `Retry-After: 5` and `Cache-Control: no-store`. Failed sources return
502 when no verified copy is obtainable. There is no unverified fallback.

### Persistence and ownership

Completed files survive restart on a **trusted local volume** without rehashing.
Use an owned mode-0700 directory under trusted parent directories; do not share
it with another service or allow external modification. Only one gateway process
may use each directory.

Startup rejects symlinks, hard links and unexpected entries, takes an exclusive
process lock, deletes abandoned temporary files and trims to current limits. LRU
order resets on restart. Active reads pin files against eviction; idle readers
are closed. Failed unlink/accounting cleanup stops cache admission until restart
rather than silently exceeding quota.

The quota covers logical blob payloads, not filesystem block/inode overhead or
the separate KV database; allow filesystem headroom. The default `./data/blobs`
directory is ignored by Git. Compose persists blobs at `/cache/verified-blobs`
in the `nsite_cache` volume.

## Metadata and event caches

Deno KV caches DNS resolution (hostname to public key and site identifier), blob
source hints and server lists, and user profiles used by gateway pages. Set
`CACHE_PATH=./data/cache` for an explicit database location; otherwise Deno uses
its default local KV location.

Fetched Nostr events remain in the in-memory event store for the process
lifetime. Set `CACHE_RELAYS=ws://localhost:4869` to persist them through a cache
relay. A relay running at that address is auto-detected.

## HTTP caching

Site files have strong ETags derived from their manifest SHA-256 hash. Changed
bytes produce new ETags; republishing unchanged files keeps the same ETag.
Matching `If-None-Match` validators (including weak validators and lists) return
304 for GET and HEAD, including requests with Range, only after a verified local
copy exists. Cold conditional requests fetch and verify the whole blob; warm
checks need no upstream fetch. Custom 404s retain status 404. `Last-Modified`
uses the manifest publication time.

Full and 304 responses use
`Cache-Control: public, max-age=<SITE_CACHE_MAX_AGE>, must-revalidate`. The
default is `3600` seconds. To require a check on every request:

```sh
SITE_CACHE_MAX_AGE=0
```

Browsers can still store and reuse files after a successful ETag check. Positive
values allow reuse without checking until the freshness interval expires.
Restart after changing the setting; existing cached responses retain their
original freshness lifetime until expiry or reload.

This is independent of `CACHE_TIME` (server-side caching) and
`RLEAY_SYNC_INTERVAL` (manifest discovery). ETags reflect the manifest currently
known to the gateway. Directory pages use `DIRECTORY_REFRESH` for HTTP
freshness.

## Loading page

When a browser navigates to a page whose manifest or file is not yet cached, the
gateway waits up to 400 ms and then answers with a temporary loading page while
it keeps fetching in the background. The page long-polls the same URL for
progress (the gateway holds each poll until the next step, at most 25 seconds)
and reloads into the site once it is ready; if the site or file is missing, the
reload shows the real error page.

The loading page is sent as `503 Service Unavailable` with `Retry-After: 2`,
`Cache-Control: no-store` and `X-Robots-Tag: noindex`, so browsers, CDNs and
search engines treat it as temporary and never store or index it. Crawlers,
scripts, subresource and range requests never receive it and wait for the real
response instead.

At most 64 background fetches and 1024 held progress polls run at once; past
those limits, navigations wait for the real response as if the loading page were
disabled. Polls never start work. Set `SITE_LOADING_PAGE=false` to disable the
loading page entirely.

## Metrics and request logs

Startup logs print limits as compact `key=value` fields. Once per minute,
`[nsite:disk-cache] metrics hits=12 misses=3 ...` reports hits, misses, fills,
failures, corrupt responses, evictions, rejections, bytes, reservations, active
fills, pending jobs, waiters and readers. Source failures include the hash
prefix, source origin and reason. `DEBUG=nsite:*` enables admission diagnostics.
The gateway's [`/health`](routing.md#gateway-pages) endpoint also exposes
verified blob cache metrics.

Every response-ready request log includes host/path, HTTP status and:

- `cache=hit|miss|coalesced|none`: local entry, request that started a fill (or
  missed before admission failed), waiter on another fill, or no cache lookup.
- `verification=previously-verified|incremental-sha256|shared-fill|none`:
  trusted disk bytes without rehashing, this request's fill hashing, waiting on
  another fill without separate hashing, or no verification.
- `verification_ms`: summed streaming body-read, incremental SHA-256 and
  temporary-file-write elapsed time across this request's fill attempts,
  including failed attempts. **Not CPU hash time.** Excludes queueing,
  discovery, HTTP header wait, file open/sync/promotion, hint updates and
  cleanup. Cancellation snapshots work observed before departure; remaining
  shared work is not attributed to a departed request. Hits and coalesced-only
  requests report zero.
- `cache_wait_ms`: wall time awaiting a missing entry, including queueing,
  discovery, download/verification, retries and hints. It overlaps verification
  time; do not add them. `verified=true` means an entry was acquired, not that
  delivery succeeded.
- `response_ready_ms`: middleware time until the response is ready, excluding
  streaming delivery. HEAD, 304 and ranges use the same attribution; non-blob
  routes report `none` and zero verification time.

```text
--> GET site.example/index.html 200 response_ready_ms=82.1 cache=miss verification=incremental-sha256 verification_ms=21.5 cache_wait_ms=64.8 verified=true
--> HEAD site.example/index.html 200 response_ready_ms=2.3 cache=hit verification=previously-verified verification_ms=0 cache_wait_ms=0 verified=true
```
