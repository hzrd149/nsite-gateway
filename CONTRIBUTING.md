# Contributing

Start with the [README](README.md) for the project overview and codebase map.
Read [AGENTS.md](AGENTS.md) for repository-specific working instructions.

## Development setup

Use Deno 2.9.8 or newer, preferably the latest patched stable release.

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
cp .env.example .env
# Review .env before starting.
NSITE_HOST=127.0.0.1 deno task dev
```

`dev` watches source files; `deno task start` runs without watching.
Configuration is documented in [docs/configuration.md](docs/configuration.md).
Run commands from the repository root.

## Checks

Run type checking and unit tests for code changes:

```sh
deno task check --frozen
deno task test --frozen
```

Format changed files with `deno fmt <paths>` and verify with
`deno fmt --check <paths>`. Keep formatting scoped to your changes.

For cache, serving or network changes, run the relevant integration suites:

| Command                                    | Coverage                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| `deno task test:blob-cache --frozen`       | Blob-cache integration and publisher isolation               |
| `deno task test:verified-cache --frozen`   | Verified disk-cache lifecycle and limits                     |
| `deno task test:verified-network --frozen` | Real loopback HTTP fills                                     |
| `deno task test:network --frozen`          | Native network permissions, resolved-IP checks and redirects |

The first three suites use local fixtures, without changing `.env` or contacting
production sites. Run `test:network` in an isolated environment: it starts local
listeners and child Deno processes.

Named permission sets in `deno.json` keep regular unit tests limited to their
required environment access. **Keep permission-heavy integration suites outside
`__tests__/`**: Deno discovers every TypeScript file in those directories during
the regular unit run. Existing integration suites live under
`src/services/integration/` and `src/helpers/integration/`.

[CI](.github/workflows/test.yml) runs unit tests, type checking and the three
cache integration suites on Deno 2.9.8. On x86_64 Linux, `nix run .#test` runs
the unit tests through the included Nix flake.

## Local site requests

To serve existing sites using loopback and isolated caches:

```sh
mkdir -p /tmp/nsite-local
NSITE_HOST=127.0.0.1 NSITE_PORT=3000 \
  CACHE_PATH=/tmp/nsite-local/cache.kv \
  BLOB_CACHE_DIR=/tmp/nsite-local/blobs \
  MAX_FILE_SIZE="128 MiB" BLOB_CACHE_BYTES=1073741824 \
  deno task start
```

Existing `.env` relay/proxy settings are still loaded and upstream services may
be contacted. Replace `SITE_HOSTNAME` and `PATH` with a known site and file:

```sh
curl --resolve 'SITE_HOSTNAME:3000:127.0.0.1' \
  'http://SITE_HOSTNAME:3000/PATH' -o /tmp/nsite-local/site-response
```

This preserves hostname routing without changing DNS.

## Relay hydration benchmark

Run the read-only benchmark against the example relays (Damus, Primal and
Ditto):

```sh
deno task bench:hydration
# Explicit relays and limits (milliseconds):
deno task bench:hydration --runs=3 --timeout=15000 --deadline=120000 wss://relay.damus.io wss://relay.primal.net wss://relay.ditto.pub
# Compare both loaders over the last 90 days:
deno task bench:hydration --runs=3 --lookback=7776000
```

The benchmark compares previous sequential one-shot requests with the sync
loader, using a fresh pool and empty store per measurement, a shared historical
upper bound and alternating run order. JSON includes first-manifest and total
time, retained manifests by kind, indexed sites, event/site-set differences and
per-relay methods and coverage. The default is three trials.

Compare counts as well as speed: legacy request completion does not prove full
coverage, and NIP-77 is neither universally supported nor necessarily faster for
an empty store. The benchmark contacts public relays but never loads `.env`,
publishes events or accesses gateway caches.

## Submitting changes

- Follow the surrounding TypeScript, Hono and service patterns. Use the
  [codebase map](README.md#codebase-map) to find the relevant layer.
- Keep changes focused and add or update tests for behavior changes.
- Update the relevant guide in `docs/` when configuration or deployment changes;
  keep the README focused on orientation.
- Add public-facing features, fixes and behavior changes to the `Unreleased`
  section of [CHANGELOG.md](CHANGELOG.md). Leave released notes unchanged.
- Commit each significant, coherent change after relevant checks pass, using a
  descriptive message and including only files belonging to the change.
- In your pull request, describe the motivation, behavior changes and checks
  run, including any integration suites that were not run.
