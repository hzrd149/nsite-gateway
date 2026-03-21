# nsite-gateway

A Deno + Hono gateway implementation for
[static websites on nostr](https://github.com/nostr-protocol/nips/pull/1538).

## Configuring

All configuration is done through the `.env` file. start by copying the example
file and modifying it.

```sh
cp .env.example .env
```

## Running with Deno

```sh
deno task start
```

The Deno tasks already include the flags required for optional local Deno KV
use.

For local development with file watching:

```sh
deno task dev
```

## Cache backends

The gateway defaults to a bounded in-memory metadata cache.

To enable persistent local caching with Deno KV, set:

```sh
CACHE_BACKEND="kv"
KV_PATH="./data/cache.kv"
```

If `KV_PATH` is omitted, Deno will use its default local KV location.

`CACHE_MAX_ENTRIES` only applies to the in-memory cache backend.

## Running directly from JSR

You can run the published package without cloning this repository:

```sh
deno run --unstable-kv --env-file=.env --allow-env --allow-net --allow-read --allow-write jsr:@hzrd149/nsite-gateway
```

## Running with docker-compose

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
docker compose up
```

The included `docker-compose.yml` enables persistent Deno KV caching with a
local volume mounted at `/cache`.

Once the service is running you can access the gateway at
`http://localhost:3000`

## Running with docker

The `ghcr.io/hzrd149/nsite-gateway` image can be used to run a http instance
locally

```sh
docker run --rm -it --name nsite -p 3000:3000 ghcr.io/hzrd149/nsite-gateway
```

## Onion header

If you operate an onion mirror separately, set `ONION_HOST` and the gateway will
return an `Onion-Location` header in responses.

```sh
ONION_HOST="http://examplehiddenservice.onion"
```

### Blossom Proxy

You can configure a `BLOSSOM_PROXY` server that will be checked first for all
blossom blobs before falling back to other servers. When set, the gateway will:

1. Check the proxy server first for each blob request
2. Include BUD-10 discovery hints as query parameters:
   - `xs` parameters: Domain names of all known blossom servers (server hints)
   - `as` parameter: The author's pubkey (author hint)

This allows the proxy to use these hints to locate blobs on other servers if it
doesn't have them cached.

The blossom proxy specification is defined in
[BUD-11](https://github.com/hzrd149/blossom/pull/89). For an example
implementation, see [flower-cache](https://github.com/hzrd149/flower-cache).

```sh
BLOSSOM_PROXY="https://blossom-proxy.example.com"
```

The proxy URL will be constructed as:

```
<BLOSSOM_PROXY>/<sha256>?xs=server1.com&xs=server2.com&as=<pubkey>
```
