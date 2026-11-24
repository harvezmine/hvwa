# labs/r06-camelot — Cryptography, Medium (Node, in-memory, stateless). One image, four levels by HVWA_LEVEL.
# Runtime contract: plan 2026-11-20-range-a-platform.md "Interfaces for Plans B–E". Standard library only
# (node:http, node:crypto, node:fs); read-only rootfs, all state in memory, /tmp is a tmpfs.
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
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "/app/server.mjs"]
