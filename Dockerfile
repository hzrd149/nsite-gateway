FROM denoland/deno:bin-2.4.5 AS build

WORKDIR /app

COPY deno.json deno.lock main.ts ./
COPY src ./src
COPY public ./public

RUN deno cache --frozen main.ts
RUN deno compile \
  --frozen \
  --allow-env \
  --allow-net \
  --allow-read \
  --output /app/nsite-gateway \
  main.ts

FROM debian:bookworm-slim AS main

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system nsite \
  && useradd --system --gid nsite --home-dir /app --create-home nsite

WORKDIR /app

COPY --from=build /app/nsite-gateway ./nsite-gateway
COPY --from=build /app/public ./public

RUN chown -R nsite:nsite /app
USER nsite

EXPOSE 3000
ENV NSITE_PORT="3000"

CMD ["./nsite-gateway"]
