# Routing and gateway pages

[README](../README.md) · [Configuration](configuration.md) ·
[Deployment](deployment.md)

## Hostname resolution

The gateway resolves incoming site hostnames in this order:

1. **npub subdomain** — `npub1abc....nsite.example.com`: a valid bech32 `npub`
   in the leftmost label identifies the author's root site (kind `15128`).
2. **Snapshot label** — `v<50-char-base36-event-id>.nsite.example.com`: a `v`
   followed by a 50-character base36 event ID selects an exact snapshot (kind
   `5128`).
3. **Named site label** — `<base36pubkey><identifier>.nsite.example.com`: a
   50-character base36 public key followed by a 1–13 character site identifier
   selects a named site (kind `35128`).
4. **CNAME resolution** — other hostnames resolve through CNAME records,
   enabling custom domains such as `myblog.com → npub1abc....nsite.example.com`.

Known gateway root hosts, including localhost and `PUBLIC_DOMAIN`, route
directly to the gateway pages rather than resolving a site.

## Gateway pages

The root domain serves server-rendered pages with no JavaScript or remote
images. Site listings use an in-memory directory snapshot rebuilt every
`DIRECTORY_REFRESH` seconds; requests never wait for relays or Blossom. These
pages use an ETag and `Cache-Control: public, max-age=<DIRECTORY_REFRESH>`.

| Route                                            | Purpose                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /`                                          | Introduction, search, recently updated or trending (`?tab=trending`) sites, 7-day sparklines and featured authors |
| `GET /search?q=<query>`                          | Search the directory or redirect a pasted site address                                                            |
| `GET /sites?sort=updated\|trending\|name&page=N` | Paginated list of known sites                                                                                     |
| `GET /author/:npub`                              | Sites published by one author                                                                                     |
| `GET /status/:address`                           | Cache-only publisher diagnostics; sends `noindex`                                                                 |
| `GET /status`                                    | Redirect to `/sites`                                                                                              |
| `GET /health`                                    | JSON version, uptime, site counts, relay connections, last relay sync and verified blob cache metrics             |
| `GET /robots.txt`                                | Disallow `/status/` and `/search`, unless overridden by `public/robots.txt`                                       |

Search matches site titles, identifiers, descriptions and author names, or
author npub prefixes. Names come only from cached profiles; searching never
loads profiles or contacts relays. Queries are truncated to 64 characters and 6
words; results are capped at 50 sites and 20 authors and cached in a bounded
per-query cache. Pasted `npub`, `naddr`, `nevent`, `nprofile`, hex public keys
or nsite URLs redirect to site subdomains. NIP-05 names are not supported.

Status pages show the manifest, relays it was seen on, Blossom servers, the last
served result per path (including bad-source marks), requested paths missing
from the manifest, snapshots and the raw event. They only read existing gateway
data; unseen sites show a short "not seen yet" page.

Visits count `.html` page views only, skipping HEAD and known bot/script user
agents. Counts are buffered in memory and written to KV every 30 seconds as
all-time totals and daily buckets retained for 30 days.

## Customization

Place `index.html` in the project-root [`public/`](../public/) directory to
replace the built-in homepage. A `public/robots.txt` overrides the default
robots policy. For container deployments, include these files in your image or
mount them into `/app/public/`.
