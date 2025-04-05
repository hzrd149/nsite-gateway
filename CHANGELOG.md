# nsite-gateway

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
