ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p public && npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/deploy/lightsail/upload-backup.mjs ./deploy/lightsail/upload-backup.mjs
COPY --from=build --chown=node:node /app/deploy/lightsail/setup-config.ts ./deploy/lightsail/setup-config.ts
USER node
EXPOSE 3000 4000
CMD ["node", "server.js"]
