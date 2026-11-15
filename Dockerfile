# HVWA app image. Deliberately vulnerable: run it ONLY via docker-compose.yml,
# which keeps it on an internal network (no egress) behind a loopback-only proxy.
# Pinned exact tag (Node >= 22.16 for node:sqlite); bump deliberately.
ARG NODE_IMAGE=node:22.23.5-alpine3.24

# --- build: full deps + TypeScript, emits dist/ (incl. views, SQL, level sources)
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- runtime: production deps only, no compilers/dev tooling, non-root
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/dist ./dist
# The named volume is seeded from this dir on first use, so it starts out
# owned by the unprivileged user. Everything else stays root-owned.
RUN mkdir -p /data && chown node:node /data
# HVWA_ALLOW_REMOTE=1 lets the server bind 0.0.0.0 inside the container; that
# is only safe because compose attaches the app to the internal `lab` network.
ENV HOST=0.0.0.0 \
    PORT=1337 \
    HVWA_ALLOW_REMOTE=1 \
    HVWA_DATA_DIR=/data
USER node
EXPOSE 1337
CMD ["node", "dist/server.js"]
