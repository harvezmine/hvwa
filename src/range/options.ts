// src/range/options.ts — createApp's options in portal mode, from the validated environment (server.ts): the platform DB
// and flag secret in the data dir, the login (Secure cookies, 10-character passwords, the first admin from
// HVWA_ADMIN_PASSWORD), and the range: registry file, warden client, range key (env or persisted), limits, proxies.
// Compact POC (plan amendment): limits are { capacity, idleMs, maxMs, startTimeoutMs }; registration is open unless
// HVWA_REGISTRATION_OPEN=0; there is no Extend, no ceiling and no event code.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppOptions } from '../app.js';
import type { Config } from '../config.js';
import { resolveFlagSecret, resolveRangeKey } from '../core/secrets.js';
import { loadRegistry, type LabRegistry } from '../lab-registry.js';
import type { WardenApi } from '../warden/protocol.js';
import { RANGE_PASSWORD_MIN_LENGTH, type RangeConfig } from './config.js';
import { DEFAULT_LIMITS } from './types.js';
import { createWardenClient } from './warden-client.js';

/** labs/registry.json of the checkout (src/ or dist/ alike); the compose stack sets HVWA_LAB_REGISTRY instead. */
export const DEFAULT_REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'labs', 'registry.json');

export function portalAppOptions(
  config: Pick<Config, 'FLAG_SECRET' | 'HVWA_ALLOWED_HOSTS' | 'HVWA_EDITION' | 'HVWA_ADMIN_PASSWORD'>,
  range: RangeConfig,
  dataDir: string,
  deps: { readonly registry?: LabRegistry; readonly warden?: WardenApi } = {},
): AppOptions {
  return {
    dbPath: join(dataDir, 'hvwa.db'),
    flagSecret: resolveFlagSecret(dataDir, config.FLAG_SECRET),
    allowedHosts: config.HVWA_ALLOWED_HOSTS,
    edition: config.HVWA_EDITION,
    mode: 'portal',
    // The POC's 40-50 concurrent players plus the range-verify health checks create far more than the default 60 new
    // sessions a minute; 600 keeps the per-session guard (it still bounds one client) out of the way of the crowd.
    maxNewSessionsPerMinute: 600,
    // Cookies are Secure exactly when the browser speaks https (behind the tunnel), and always host-only.
    auth: {
      initialPassword: config.HVWA_ADMIN_PASSWORD, secureCookies: range.publicScheme === 'https', publicScheme: range.publicScheme,
      passwordMinLength: RANGE_PASSWORD_MIN_LENGTH,
    },
    range: {
      domain: range.domain,
      portalHost: range.portalHost,
      publicScheme: range.publicScheme,
      publicPort: range.publicPort,
      internalHost: range.internalHost,
      registry: deps.registry ?? loadRegistry(range.registryPath ?? DEFAULT_REGISTRY_PATH),
      warden: deps.warden ?? createWardenClient({ baseUrl: range.wardenUrl, secret: range.wardenSecret }),
      rangeKey: resolveRangeKey(dataDir, range.rangeKey),
      forwardAuthSecret: range.forwardAuthSecret,
      limits: {
        capacity: range.capacity, idleMs: range.idleMs, maxMs: range.maxMs, startTimeoutMs: DEFAULT_LIMITS.startTimeoutMs,
      },
      registrationOpen: range.registrationOpen,
      secureCookies: range.publicScheme === 'https',
    },
  };
}
