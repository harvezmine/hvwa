import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { resolveFlagSecret } from '../src/core/secrets.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('config', () => {
  it('defaults to a localhost bind and has no SESSION_SECRET', () => {
    const c = parseConfig({});
    expect(c).toMatchObject({ HOST: '127.0.0.1', PORT: 1337, AI_BACKEND: 'sim' });
    expect(c.FLAG_SECRET).toBeUndefined();
    expect(c).not.toHaveProperty('SESSION_SECRET');
    expect(parseConfig({ SESSION_SECRET: 'x' })).not.toHaveProperty('SESSION_SECRET');
  });

  it('treats an empty or whitespace FLAG_SECRET as unset (no ZodError)', () => {
    expect(() => parseConfig({ FLAG_SECRET: '' })).not.toThrow();
    expect(parseConfig({ FLAG_SECRET: '' }).FLAG_SECRET).toBeUndefined();
    expect(parseConfig({ FLAG_SECRET: '   ' }).FLAG_SECRET).toBeUndefined();
    expect(parseConfig({ FLAG_SECRET: '  s3cret  ' }).FLAG_SECRET).toBe('s3cret');
  });

  it('an empty FLAG_SECRET falls back to the persisted secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-config-'));
    dirs.push(dir);
    const secret = resolveFlagSecret(dir, parseConfig({ FLAG_SECRET: '' }).FLAG_SECRET);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'flag-secret'), 'utf8').trim()).toBe(secret);
  });
});
