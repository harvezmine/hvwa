// The platform login's password hashing (src/auth/password.ts) and brute-force backoff schedule (src/auth/service.ts).
import { describe, it, expect } from 'vitest';
import { scryptSync } from 'node:crypto';
import { hashPassword, hashPasswordSync, verifyPassword, SCRYPT_PARAMS } from '../src/auth/password.js';
import { AUTH_LIMITS, lockMsAfter } from '../src/auth/service.js';

const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

describe('password hashing (scrypt, node:crypto)', () => {
  it('uses sane parameters: N >= 2^15, r = 8, p = 1, a 16-byte salt and a 64-byte key', () => {
    expect(SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(2 ** 15);
    expect(Math.log2(SCRYPT_PARAMS.N) % 1).toBe(0);
    expect(SCRYPT_PARAMS).toMatchObject({ r: 8, p: 1, saltBytes: 16, keyBytes: 64 });
  });

  it('stores scrypt$N$r$p$salt$key only: never the password, a fresh salt each time', async () => {
    const a = await hashPassword('correct horse');
    const b = hashPasswordSync('correct horse');
    for (const h of [a, b]) {
      const m = HASH_RE.exec(h);
      expect(m, h).not.toBeNull();
      expect(m?.slice(1, 4).map(Number)).toEqual([SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p]);
      expect(Buffer.from(m?.[4] ?? '', 'base64url')).toHaveLength(16);
      expect(Buffer.from(m?.[5] ?? '', 'base64url')).toHaveLength(64);
      expect(h).not.toContain('correct horse');
    }
    expect(a).not.toBe(b); // per-hash salt
    expect(HASH_RE.exec(a)?.[4]).not.toBe(HASH_RE.exec(b)?.[4]);
  });

  it('the stored key is scrypt(password, salt) with the stored parameters', () => {
    const h = hashPasswordSync('p@ss-word');
    const [, N, r, p, salt, key] = HASH_RE.exec(h) ?? [];
    const expected = scryptSync('p@ss-word', Buffer.from(salt, 'base64url'), 64,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
    expect(Buffer.from(key, 'base64url').equals(expected)).toBe(true);
  });

  it('verifies the right password and refuses every other one', async () => {
    const h = await hashPassword('password123');
    expect(await verifyPassword('password123', h)).toBe(true);
    for (const wrong of ['password1234', 'Password123', 'password12', '', ' password123', 'password123\0']) {
      expect(await verifyPassword(wrong, h), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('a malformed or truncated stored hash verifies nothing (and never throws)', async () => {
    const h = await hashPassword('password123');
    const [head, key] = [h.slice(0, h.lastIndexOf('$')), h.slice(h.lastIndexOf('$') + 1)];
    for (const bad of ['', 'password123', 'scrypt$1$8$1$x$y', `${head}$${key.slice(0, 20)}`, h.replace('scrypt$', 'bcrypt$'),
      'scrypt$32768$8$1$$', `scrypt$4294967296$8$1$${h.split('$')[4]}$${key}`]) {
      await expect(verifyPassword('password123', bad), bad).resolves.toBe(false);
    }
  });

  it('handles any Unicode password (UTF-8), including very long ones', async () => {
    const pw = `kata sandi \u{1F512} ${'x'.repeat(900)}`;
    const h = await hashPassword(pw);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword(pw.slice(0, -1), h)).toBe(false);
  });
});

describe('backoff schedule (lockMsAfter)', () => {
  it('locks from the fifth consecutive failure, doubling from 30 s, capped at 15 min', () => {
    expect(AUTH_LIMITS).toMatchObject({ freeFailures: 5, lockBaseMs: 30_000, lockCapMs: 15 * 60_000 });
    expect([0, 1, 2, 3, 4].map(lockMsAfter)).toEqual([0, 0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9].map(lockMsAfter)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(lockMsAfter(10)).toBe(15 * 60_000); // 960 s would exceed the cap
    expect(lockMsAfter(1000)).toBe(15 * 60_000);
    expect(lockMsAfter(Number.MAX_SAFE_INTEGER)).toBe(15 * 60_000);
  });
});
