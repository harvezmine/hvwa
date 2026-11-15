// src/core/secrets.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Flag secret for the server: FLAG_SECRET from the environment if set,
// otherwise a random 32-byte hex secret created once and persisted at
// <dataDir>/flag-secret. There is no shared, publicly-known default.
export function resolveFlagSecret(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.FLAG_SECRET?.trim();
  if (fromEnv) return fromEnv;
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
