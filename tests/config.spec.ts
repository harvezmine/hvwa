import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, isLoopbackHost, bindRefusal } from '../src/config.js';
import { resolveFlagSecret } from '../src/core/secrets.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SECRET16 = '0123456789abcdef';

describe('parseConfig', () => {
  it('defaults to a localhost bind, no remote, no data-dir override, no SESSION_SECRET', () => {
    const c = parseConfig({});
    expect(c).toEqual({
      HOST: '127.0.0.1', PORT: 1337, AI_BACKEND: 'sim',
      FLAG_SECRET: undefined, HVWA_ALLOW_REMOTE: false, HVWA_DATA_DIR: undefined,
    });
    expect(parseConfig({ SESSION_SECRET: 'x' })).not.toHaveProperty('SESSION_SECRET');
  });

  it.each(['', '   '])('blank HOST and PORT (%j) mean "unset"', (blank) => {
    expect(parseConfig({ HOST: blank, PORT: blank })).toMatchObject({ HOST: '127.0.0.1', PORT: 1337 });
  });

  it('trims HOST and coerces a valid PORT', () => {
    expect(parseConfig({ HOST: ' localhost ', PORT: '8080' })).toMatchObject({ HOST: 'localhost', PORT: 8080 });
    expect(parseConfig({ PORT: '1' }).PORT).toBe(1);
    expect(parseConfig({ PORT: '65535' }).PORT).toBe(65535);
  });

  it.each(['0', '65536', '1.5', 'abc', '-1', '80x'])('rejects PORT %j', (PORT) => {
    expect(() => parseConfig({ PORT })).toThrow();
  });

  it('treats an empty or whitespace FLAG_SECRET as unset (no ZodError)', () => {
    expect(parseConfig({ FLAG_SECRET: '' }).FLAG_SECRET).toBeUndefined();
    expect(parseConfig({ FLAG_SECRET: '   ' }).FLAG_SECRET).toBeUndefined();
    expect(parseConfig({ FLAG_SECRET: `  ${SECRET16}  ` }).FLAG_SECRET).toBe(SECRET16);
  });

  it.each(['short', '0123456789abcde'])('rejects a FLAG_SECRET shorter than 16 chars (%j)', (FLAG_SECRET) => {
    expect(() => parseConfig({ FLAG_SECRET })).toThrow();
  });

  it('HVWA_ALLOW_REMOTE is true only for "1"', () => {
    expect(parseConfig({ HVWA_ALLOW_REMOTE: '1' }).HVWA_ALLOW_REMOTE).toBe(true);
    expect(parseConfig({ HVWA_ALLOW_REMOTE: '0' }).HVWA_ALLOW_REMOTE).toBe(false);
    expect(parseConfig({ HVWA_ALLOW_REMOTE: '' }).HVWA_ALLOW_REMOTE).toBe(false);
    expect(() => parseConfig({ HVWA_ALLOW_REMOTE: 'yes' })).toThrow();
  });

  it('HVWA_DATA_DIR is optional, blank means unset', () => {
    expect(parseConfig({ HVWA_DATA_DIR: '' }).HVWA_DATA_DIR).toBeUndefined();
    expect(parseConfig({ HVWA_DATA_DIR: '/var/lib/hvwa' }).HVWA_DATA_DIR).toBe('/var/lib/hvwa');
  });

  it('an empty FLAG_SECRET falls back to the persisted secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-config-'));
    dirs.push(dir);
    const secret = resolveFlagSecret(dir, parseConfig({ FLAG_SECRET: '' }).FLAG_SECRET);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'flag-secret'), 'utf8').trim()).toBe(secret);
  });
});

describe('loopback bind guard', () => {
  it.each(['127.0.0.1', '::1', 'localhost', 'LOCALHOST'])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'localhost.evil.test', 'example.com', ''])(
    '%j is not loopback', (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    });

  it('allows a loopback HOST', () => {
    expect(bindRefusal(parseConfig({}))).toBeUndefined();
    expect(bindRefusal(parseConfig({ HOST: '::1' }))).toBeUndefined();
  });

  it('refuses a non-loopback HOST unless HVWA_ALLOW_REMOTE=1', () => {
    const msg = bindRefusal(parseConfig({ HOST: '0.0.0.0' }));
    expect(msg).toMatch(/0\.0\.0\.0/);
    expect(msg).toMatch(/HVWA_ALLOW_REMOTE=1/);
    expect(bindRefusal(parseConfig({ HOST: '0.0.0.0', HVWA_ALLOW_REMOTE: '1' }))).toBeUndefined();
  });
});
