FROM denoland/deno:2.7.7 AS main

WORKDIR /app

COPY deno.json deno.lock main.ts ./
COPY src ./src
COPY public ./public

RUN deno cache --frozen --unstable-kv main.ts

EXPOSE 3000
ENV NSITE_PORT="3000"

CMD ["run", "--frozen", "--cached-only", "--unstable-kv", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "main.ts"]
