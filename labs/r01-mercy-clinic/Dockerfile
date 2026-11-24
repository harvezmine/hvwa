# labs/r01-mercy-clinic — SQL injection, Easy (Node + SQLite). One image, three levels by HVWA_LEVEL. Runtime contract:
# docs/superpowers/plans/2026-11-20-range-a-platform.md "Interfaces for Plans B–E". Standard library only; node:sqlite
# needs --experimental-sqlite. Read-only rootfs; the DB lives in the /tmp tmpfs.
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=4s --start-period=30s --start-interval=500ms --retries=3 CMD wget -q -T 3 -O /dev/null "http://127.0.0.1:${HVWA_PORT:-8080}/healthz" || exit 1
CMD ["node", "--experimental-sqlite", "/app/server.mjs"]
