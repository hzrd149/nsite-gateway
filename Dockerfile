FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY package.json .
COPY pnpm-lock.yaml .

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json .
COPY src ./src
RUN pnpm build

FROM base AS main

# Setup user
RUN addgroup -S nsite && adduser -S nsite -G nsite
RUN chown -R nsite:nsite /app

# setup nsite
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build ./app/build ./build

COPY ./public ./public

EXPOSE 80 3000
ENV NSITE_PORT="3000"

CMD ["node", "."]
