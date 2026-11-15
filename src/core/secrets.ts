// src/core/secrets.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Flag secret for the server: the configured FLAG_SECRET (config.ts, the
// single source for env parsing) if set, otherwise a random 32-byte hex secret
// created once and persisted at <dataDir>/flag-secret. No public default.
export function resolveFlagSecret(dataDir: string, configured: string | undefined): string {
  const fromConfig = configured?.trim();
  if (fromConfig) return fromConfig;
  const file = join(dataDir, 'flag-secret');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}
