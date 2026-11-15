import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const CONFIGURED = 'configured-secret-0001'; // >= 16 chars

describe('resolveFlagSecret', () => {
  it('prefers the configured FLAG_SECRET and writes nothing', () => {
    const dir = tempDir();
    expect(resolveFlagSecret(dir, CONFIGURED)).toBe(CONFIGURED);
    expect(existsSync(join(dir, 'flag-secret'))).toBe(false);
  });

  it('rejects a configured secret shorter than 16 characters', () => {
    expect(() => resolveFlagSecret(tempDir(), 'from-env')).toThrow(/at least 16/);
  });

  it('creates a random 32-byte hex secret once and reuses it', () => {
    const dir = join(tempDir(), 'nested', 'data'); // directory created on demand
    const first = resolveFlagSecret(dir, undefined);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'flag-secret'), 'utf8').trim()).toBe(first);
    expect(resolveFlagSecret(dir, undefined)).toBe(first);
  });

  it('two fresh data dirs get different secrets (no shared public default)', () => {
    expect(resolveFlagSecret(tempDir(), undefined)).not.toBe(resolveFlagSecret(tempDir(), undefined));
  });

  it.each([['short'], ['   '], ['0123456789abcde']])(
    'regenerates a persisted secret that is too short (%j) and warns', (stored) => {
      const dir = tempDir();
      writeFileSync(join(dir, 'flag-secret'), stored);
      const warnings: string[] = [];
      const secret = resolveFlagSecret(dir, undefined, (m) => warnings.push(m));
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(dir, 'flag-secret'), 'utf8').trim()).toBe(secret);
      expect(warnings.join('\n')).toMatch(/flag-secret.*regenerat/i);
    });

  it('keeps a valid persisted secret without warning', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'flag-secret'), `${CONFIGURED}\n`);
    const warnings: string[] = [];
    expect(resolveFlagSecret(dir, undefined, (m) => warnings.push(m))).toBe(CONFIGURED);
    expect(warnings).toEqual([]);
  });
});
