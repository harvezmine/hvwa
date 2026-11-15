import { z } from 'zod';

// Blank / whitespace-only env values (e.g. `PORT=` in a .env file) mean
// "unset" — the default applies — rather than a validation error.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unsetIfBlank = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema);

const schema = z.object({
  HOST: unsetIfBlank(z.string().trim().min(1).default('127.0.0.1')),
  PORT: unsetIfBlank(z.coerce.number().int().min(1).max(65535).default(1337)),
  // No default: server.ts falls back to a random secret persisted in <data>/flag-secret.
  FLAG_SECRET: unsetIfBlank(z.string().trim().min(16, 'FLAG_SECRET must be at least 16 characters').optional()),
  AI_BACKEND: unsetIfBlank(z.enum(['sim', 'ollama', 'byo']).default('sim')),
  // Opt-in to a non-loopback HOST (the Docker image sets this inside the container).
  HVWA_ALLOW_REMOTE: unsetIfBlank(z.enum(['0', '1']).default('0')).transform((v) => v === '1'),
  // Where the server keeps hvwa.db and flag-secret (default: <project>/data).
  HVWA_DATA_DIR: unsetIfBlank(z.string().trim().min(1).optional()),
});

export type Config = z.infer<typeof schema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return schema.parse(env);
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

export const config = parseConfig(process.env);
