FROM denoland/deno:2.4.5 AS main

WORKDIR /app

COPY deno.json deno.lock main.ts ./
COPY src ./src
COPY public ./public

RUN deno cache --frozen main.ts

EXPOSE 3000
ENV NSITE_PORT="3000"

CMD ["run", "--frozen", "--cached-only", "--allow-env", "--allow-net", "--allow-read", "main.ts"]
