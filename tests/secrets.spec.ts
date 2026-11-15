import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFlagSecret } from '../src/core/secrets.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hvwa-secret-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('resolveFlagSecret', () => {
  it('prefers FLAG_SECRET from the environment and writes nothing', () => {
    const dir = tempDir();
    expect(resolveFlagSecret(dir, { FLAG_SECRET: 'from-env' })).toBe('from-env');
    expect(existsSync(join(dir, 'flag-secret'))).toBe(false);
  });

  it('creates a random 32-byte hex secret once and reuses it', () => {
    const dir = join(tempDir(), 'nested', 'data'); // directory created on demand
    const first = resolveFlagSecret(dir, {});
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'flag-secret'), 'utf8').trim()).toBe(first);
    expect(resolveFlagSecret(dir, {})).toBe(first);
  });

  it('two fresh data dirs get different secrets (no shared public default)', () => {
    expect(resolveFlagSecret(tempDir(), {})).not.toBe(resolveFlagSecret(tempDir(), {}));
  });
});
