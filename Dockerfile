FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM base AS prod-deps
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn workspaces focus --production

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    TZ=UTC
WORKDIR /app
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node --chmod=755 scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
