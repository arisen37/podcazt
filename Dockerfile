# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY scripts/prisma-postinstall.mjs ./scripts/prisma-postinstall.mjs
# Keep dependency lifecycle scripts enabled, but generate Prisma after copying its schema.
RUN --mount=type=cache,id=podcazt-npm,target=/root/.npm,sharing=locked \
    PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci --prefer-offline --no-audit --no-fund

FROM deps AS client
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm run db:generate

FROM client AS build
COPY . .
RUN --mount=type=cache,target=/app/.next/cache \
    mkdir -p public && npm run build

# Pruning depends on packages and the generated client, not application source.
FROM client AS production-deps
RUN --mount=type=cache,id=podcazt-npm,target=/root/.npm,sharing=locked \
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/deploy/lightsail/upload-backup.mjs ./deploy/lightsail/upload-backup.mjs
COPY --from=build --chown=node:node /app/deploy/lightsail/setup-config.ts ./deploy/lightsail/setup-config.ts
USER node
EXPOSE 3000 4000
CMD ["node", "server.js"]
