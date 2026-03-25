# nsite-gateway

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
