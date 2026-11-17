# HVWA app image. Deliberately vulnerable: run it ONLY via docker-compose.yml (or,
# for the published image, docker-compose.hub.yml), which keeps it on an internal
# network (no egress) behind a loopback-only proxy.
#   docker build -t hvwa-app:local .                                    (full)
#   docker build --build-arg HVWA_EDITION=lite -t sigmajo/hvwa:lite .   (lite)
# Pinned exact tag (Node >= 22.16 for node:sqlite); bump deliberately. For
# byte-for-byte reproducible builds, also pin the digest, e.g.
#   node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# (at the cost of bumping it by hand for every base-image security fix).
ARG NODE_IMAGE=node:22.23.5-alpine3.24

# --- build: full deps + TypeScript, emits dist/ (incl. views, SQL, level sources)
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
# Only what `npm run build` runs (prebuild/postbuild), so editing other scripts
# (verify-*.mjs) does not invalidate the compile layer.
COPY scripts/clean-dist.mjs scripts/copy-assets.mjs scripts/main-module.mjs ./scripts/
COPY src ./src
RUN npm run build

# --- runtime: production deps only, no compilers/dev tooling, non-root
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Production deps without install scripts; then remove the package managers
# (npm, npx, yarn, corepack): the running lab needs only `node`, and an
# exploited lab should not find them.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm /tmp/* \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
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
# Which challenges the image serves (src/editions.ts): full (default) or lite.
# Declared this late so both editions share every layer above. NODE_ENV=production
# (above) also turns the platform login on: admin / password until it is changed.
ARG HVWA_EDITION=full
RUN case "$HVWA_EDITION" in full|lite) ;; *) echo "HVWA_EDITION must be full or lite, got '$HVWA_EDITION'" >&2; exit 1 ;; esac
ENV HVWA_EDITION=${HVWA_EDITION}
LABEL org.opencontainers.image.title="HVWA" \
      org.opencontainers.image.description="Holy Vulnerable Web App: a DELIBERATELY VULNERABLE web security lab. Run it only with docker-compose.hub.yml (loopback-only, no egress)." \
      org.opencontainers.image.licenses="MIT" \
      io.hvwa.edition="${HVWA_EDITION}"
# The pull-only compose file travels with the image, so `docker cp` can hand it
# to someone who has nothing but Docker (README "Run from Docker Hub"). Root-owned.
COPY docker-compose.hub.yml ./
USER node
EXPOSE 1337
CMD ["node", "dist/server.js"]
