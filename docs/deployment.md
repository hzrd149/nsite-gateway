# Deployment

[README](../README.md) · [Configuration](configuration.md) ·
[Caching](caching.md)

## Deno

Use **Deno 2.9.8 or newer**, preferably the latest patched stable release. Deno
2.8.1 fixed the original `fetch()` resolved-IP permission bypass
([advisory](https://github.com/denoland/deno/security/advisories/GHSA-cpgj-f7g3-2pp2));
the gateway's network-deny policy is tested on 2.9.8. Upgrading alone does not
block private destinations.

From the repository root:

```sh
cp .env.example .env
# Edit .env for your deployment.
deno task start
```

For development with file watching, use `deno task dev`. Tasks supply
`--unstable-kv`, `--env-file=.env` and a named permission set.

Permissions live in [`deno.json`](../deno.json) and require explicit selection:

```sh
deno run -P=gateway --unstable-kv --env-file=.env main.ts
```

The `gateway` set supports internal services. The `gateway-public-ipv4` set adds
the restrictions described [below](#public-network-only-mode-ipv4).

The project enables Deno's `no-legacy-abort` behavior: request signals cancel on
disconnect, not successful delivery. Direct launches outside the project need
`--unstable-no-legacy-abort`. Readers release pins on EOF, stream cancellation,
errors or idle timeout. In Deno 2.9.8, mid-stream disconnects can trigger body
cancellation or request-signal abort; pre-response disconnects abort the request
signal. See
[Deno's migration guidance](https://docs.deno.com/go/unstable-no-legacy-abort).

## Published JSR package

To run without cloning, prepare a `.env` file using the
[configuration reference](configuration.md), then run:

```sh
deno run --unstable-kv --unstable-no-legacy-abort --env-file=.env --allow-env --allow-net --allow-read --allow-write --allow-sys=uid jsr:@hzrd149/nsite-gateway
```

## Docker

```sh
docker run --rm -it --name nsite -p 3000:3000 \
  ghcr.io/hzrd149/nsite-gateway:master
```

To configure the gateway and retain both caches and the stats database:

```sh
docker run --rm -it --name nsite -p 3000:3000 \
  --env-file .env \
  -e CACHE_PATH=/cache/nsite-gateway.kv \
  -e BLOB_CACHE_DIR=/cache/verified-blobs \
  -e STATS_PATH=/data/stats.db \
  -v nsite_cache:/cache \
  -v nsite_data:/data \
  ghcr.io/hzrd149/nsite-gateway:master
```

The image enables `--unstable-kv` and the `gateway` permission set, including
read/write access and `sys:uid` for cache ownership checks. Without volumes,
cache data and stats are lost when the container is removed.

## Docker Compose

The included [`docker-compose.yml`](../docker-compose.yml) runs:

- `nsite`: the gateway, exposed on port 3000.
- `caddy`: TLS termination and reverse proxy on ports 80 and 443.
- `blossom`: flower-cache, wired as `BLOSSOM_PROXY`.

Before starting:

1. Edit the included [`Caddyfile`](../Caddyfile), replacing `example.com` with
   your gateway domain and configuring TLS for the hostnames you serve.
2. Set `PUBLIC_DOMAIN` and other gateway settings in the `nsite.environment`
   block or a Compose override. The supplied stack does **not** pass `.env` into
   the container; add `env_file: .env` if desired. Explicit Compose
   `environment` entries override values from `env_file`.
3. Configure DNS and certificates as described below.

```sh
docker compose up -d
```

The gateway is also reachable directly at `http://localhost:3000`. The
`nsite_cache` volume stores KV at `/cache/nsite-gateway.kv` and verified blobs
under `/cache/verified-blobs`. The separate `nsite_data` volume holds the stats
database at `/data/stats.db`, so the cache volume can be wiped without losing
visit counts or trending data. Separate volumes persist Caddy state and Flower's
cache.

## DNS and TLS

Point the gateway's root domain and site subdomains at the deployment. Set
`PUBLIC_DOMAIN` to the root hostname (without a URL scheme). Preserve the
incoming hostname through the reverse proxy so the gateway can select the site.
Custom domains use CNAME records pointing at an nsite hostname; see
[hostname resolution](routing.md#hostname-resolution).

The sample Caddyfile includes a wildcard hostname. Wildcard certificates require
a DNS challenge and a Caddy build with your DNS provider's module, or separately
provisioned certificates. The stock `caddy:alpine` image does not include
provider-specific DNS modules. Adapt the TLS setup before using that sample in
production; custom domains also need certificate coverage.

## Public-network-only mode (IPv4)

**Prerequisite: disable IPv6 egress or block it at the network boundary.** Deno
2.9.8 accepts IPv4 subnet rules but rejects IPv6 subnet syntax in its CLI. This
profile denies IPv6 loopback explicitly but cannot block all private IPv6
ranges, so it is insufficient for dual-stack hosts without external
restrictions.

For an IPv4-only gateway using only public upstream services:

```sh
# Set NSITE_HOST in .env to a public IP assigned to this machine first.
deno task start:public:ipv4
# Equivalent direct invocation:
deno run -P=gateway-public-ipv4 --no-prompt --unstable-kv --env-file=.env main.ts
```

Native `fetch()` and Deno's `--deny-net` rules block private, loopback,
link-local, multicast, documentation and other special-purpose IPv4
destinations. Deno connects to the resolved addresses it checked, preventing DNS
rebinding between validation and connection while retaining native pooling, TLS
and HTTP/2. Blossom's bounded manual redirect loop subjects each hop to the
runtime policy.

Deployment constraints:

- Permissions affect the whole process: listeners, DNS, relays and proxies.
- `0.0.0.0`, private bind addresses and `::` are denied. Bind to a public IP
  assigned to the host. This is not a drop-in replacement for the Compose stack.
- Local relay/proxy auto-detection fails harmlessly. Explicit private relay,
  `BLOSSOM_PROXY` and `BLOSSOM_SERVERS` settings cannot be used. An allowed
  hostname cannot override a denied resolved IP.
- DNS operations using a denied local resolver may fail; resolver access must be
  compatible with the policy.
- Do not use `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or another forwarding
  proxy unless it independently enforces the same destination policy.
- Flower fetches on publishers' behalf and needs its own outbound restrictions;
  gateway permissions do not protect Flower.

The standard `start`/`dev` tasks, executable shebang, JSR command and default
Docker command allow unrestricted networking for internal-service compatibility.
**They do not provide private-network SSRF protection.** Enforce outbound policy
at the network/proxy boundary or isolate public fetching from trusted internal
services. Do not weaken the deny list merely to enable a private service.

See [contributing](../CONTRIBUTING.md#checks) for the explicit network-policy
integration test. See [caching](caching.md) for trusted-volume requirements and
capacity planning.
