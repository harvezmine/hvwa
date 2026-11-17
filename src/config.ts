import { z } from 'zod';
import { MIN_FLAG_SECRET_LENGTH } from './core/flags.js';
import { DEFAULT_EDITION, EDITIONS, type Edition } from './editions.js';

// Blank / whitespace-only env values (e.g. `PORT=` in a .env file) mean
// "unset" — the default applies — rather than a validation error.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unsetIfBlank = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema);

// HVWA_ALLOWED_HOSTS entries: a DNS name / IPv4 (labels of letters, digits and
// inner hyphens) or a bracketed IPv6 literal. No scheme, port, path or wildcard.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ALLOWED_HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])$`);

// Which challenges this server serves (src/editions.ts). createApp() reads the same rule when it gets
// no `edition` option (editionFrom below).
const EDITION_SETTING = unsetIfBlank(z.enum(EDITIONS).default(DEFAULT_EDITION));

const schema = z.object({
  HOST: unsetIfBlank(z.string().trim().min(1).default('127.0.0.1')),
  PORT: unsetIfBlank(z.coerce.number().int().min(1).max(65535).default(1337)),
  // No default: server.ts falls back to a random secret persisted in <data>/flag-secret.
  FLAG_SECRET: unsetIfBlank(z.string().trim().min(MIN_FLAG_SECRET_LENGTH, `must be at least ${MIN_FLAG_SECRET_LENGTH} characters`).optional()),
  AI_BACKEND: unsetIfBlank(z.enum(['sim', 'ollama', 'byo']).default('sim')),
  // Opt-in to a non-loopback HOST (the Docker image sets this inside the container).
  HVWA_ALLOW_REMOTE: unsetIfBlank(z.enum(['0', '1']).default('0')).transform((v) => v === '1'),
  // Where the server keeps hvwa.db and flag-secret (default: <project>/data).
  HVWA_DATA_DIR: unsetIfBlank(z.string().trim().min(1).optional()),
  // Extra Host names the server answers to, besides localhost, 127.0.0.1 and
  // [::1] (DNS-rebinding guard, core/host-guard.ts). Comma-separated.
  HVWA_ALLOWED_HOSTS: unsetIfBlank(z.string().default('')).transform((raw, ctx) => {
    const hosts = raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
    for (const h of hosts) {
      if (!ALLOWED_HOST_RE.test(h)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${h}" is not a bare hostname or IP (no scheme, port, path or wildcard)`,
        });
      }
    }
    return hosts;
  }),
  HVWA_EDITION: EDITION_SETTING,
});

export type Config = z.infer<typeof schema>;

/** Parse or throw (ZodError). Used by tests; the server uses loadConfig(). */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return schema.parse(env);
}

export type LoadResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/**
 * Parse without throwing. On failure, `errors` holds one line per issue as
 * `<path>: <message>` (e.g. `PORT: Number must be less than or equal to 65535`).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): LoadResult {
  const r = schema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message.replace(/\s+/g, ' ')}`),
  };
}

/** One setting parsed on its own (createApp()'s defaults), or a readable Error naming it. */
function setting<T>(name: string, s: z.ZodType<T, z.ZodTypeDef, unknown>, env: Record<string, string | undefined>): T {
  const r = s.safeParse(env[name]);
  if (r.success) return r.data;
  throw new Error(`${name}: ${r.error.issues.map((i) => i.message).join('; ')}`);
}

/** HVWA_EDITION alone: createApp()'s edition when it is given none. Throws on an invalid value. */
export function editionFrom(env: Record<string, string | undefined> = process.env): Edition {
  return setting('HVWA_EDITION', EDITION_SETTING, env);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/** True only for 127.0.0.1, ::1 and localhost (case-insensitive). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Why the server must refuse to start with this config, or undefined if the
 * bind is allowed. HVWA is deliberately vulnerable: binding anything but
 * loopback requires an explicit HVWA_ALLOW_REMOTE=1.
 */
export function bindRefusal(cfg: Pick<Config, 'HOST' | 'HVWA_ALLOW_REMOTE'>): string | undefined {
  if (isLoopbackHost(cfg.HOST) || cfg.HVWA_ALLOW_REMOTE) return undefined;
  return `Refusing to bind HVWA to non-loopback HOST "${cfg.HOST}": this app is deliberately ` +
    'vulnerable. Use 127.0.0.1, ::1 or localhost, or set HVWA_ALLOW_REMOTE=1 only inside an ' +
    'isolated container/network.';
}
