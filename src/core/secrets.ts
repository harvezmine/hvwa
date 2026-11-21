// src/core/secrets.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_FLAG_SECRET_LENGTH, isValidFlagSecret } from './flags.js';

// Flag secret for the server: the configured FLAG_SECRET (config.ts, the
// single source for env parsing) if set, otherwise a random 32-byte hex secret
// created once and persisted at <dataDir>/flag-secret. No public default.
// A persisted secret shorter than MIN_FLAG_SECRET_LENGTH is regenerated (with
// a warning); a configured one that short is an error.
export function resolveFlagSecret(
  dataDir: string,
  configured: string | undefined,
  warn: (message: string) => void = console.warn,
): string {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    if (!isValidFlagSecret(fromConfig)) {
      throw new Error(`FLAG_SECRET must be at least ${MIN_FLAG_SECRET_LENGTH} characters`);
    }
    return fromConfig;
  }
  const file = join(dataDir, 'flag-secret');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (isValidFlagSecret(stored)) return stored;
    warn(`${file}: stored flag secret is shorter than ${MIN_FLAG_SECRET_LENGTH} characters; ` +
      'regenerating it (flags issued with the old secret stop verifying)');
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/** Shortest range key (portal mode: the flag MAC key and the gate-cookie key's root). */
export const MIN_RANGE_KEY_LENGTH = 32;

/**
 * The range key (portal mode, spec range §6): HVWA_RANGE_KEY if set, else a random 32-byte hex key created once and
 * persisted at <dataDir>/range-key (mode 0600), like the flag secret. A stored key that is too short is regenerated
 * with a warning: flags of live instances then stop verifying (records keep only hashes) and every gate cookie expires.
 */
export function resolveRangeKey(dataDir: string, configured: string | undefined, warn: (message: string) => void = console.warn): string {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    if (fromConfig.length < MIN_RANGE_KEY_LENGTH) throw new Error(`HVWA_RANGE_KEY must be at least ${MIN_RANGE_KEY_LENGTH} characters`);
    return fromConfig;
  }
  const file = join(dataDir, 'range-key');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= MIN_RANGE_KEY_LENGTH) return stored;
    warn(`${file}: stored range key is shorter than ${MIN_RANGE_KEY_LENGTH} characters; regenerating it`);
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}
