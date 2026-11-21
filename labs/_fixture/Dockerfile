# labs/_fixture — NOT a lab: the minimal range instance scripts/range-verify.mjs launches to prove the platform (hardening,
# routing, gate, forward-auth, flag delivery, isolation). It follows the range lab runtime contract (plan
# docs/superpowers/plans/2026-11-20-range-a-platform.md, "Interfaces for Plans B–E"): uid 10001, a read-only rootfs with
# /tmp as the only writable path, HVWA_FLAG planted then removed from the environment, a HEALTHCHECK on lab.json's health.
#   docker build -t hvwa-lab/r00:verify labs/_fixture
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "/app/server.mjs"]
