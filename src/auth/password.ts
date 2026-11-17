// src/auth/password.ts — the platform login's password hashing: scrypt from node:crypto, a fresh random
// salt per hash, and a constant-time comparison. Only `scrypt$N$r$p$<salt>$<key>` (base64url) is ever
// stored; the password itself never leaves the request that carried it.
import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * N = 2^15, r = 8, p = 1: 32 MiB and roughly 50-100 ms per hash on a laptop. The async form runs on
 * libuv's thread pool (4 threads by default), so concurrent sign-ins hold at most ~128 MiB, inside the
 * container's 512 MiB. Stored with every hash, so a later change still verifies old ones.
 */
export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, saltBytes: 16, keyBytes: 64 });
const MAXMEM = 64 * 1024 * 1024; // 128 * N * r = 32 MiB, plus headroom (Node's default cap is exactly 32 MiB)
/**
 * The most a STORED hash may ask for, checked before any work: never more than 4x the current cost, so a
 * tampered row (anyone who can write the platform DB) cannot make one check take minutes or gigabytes.
 */
export const STORED_HASH_LIMITS = Object.freeze({ maxN: 2 ** 17, maxR: 16, maxP: 4 });

/** What the login uses to hash and check passwords; tests wrap it to count checks (src/auth/service.ts). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  hashSync(password: string): string;
  verify(password: string, stored: string): Promise<boolean>;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function encode(salt: Buffer, key: Buffer): string {
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function options(N: number, r: number, p: number): ScryptOptions {
  return { N, r, p, maxmem: Math.max(MAXMEM, 256 * N * r) };
}

function derive(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const { N, r, p, keyBytes } = SCRYPT_PARAMS;
  return encode(salt, await derive(password, salt, keyBytes, options(N, r, p)));
}

/** The same, synchronously: only for creating the account once at startup. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const { N, r, p, keyBytes } = SCRYPT_PARAMS;
  return encode(salt, scryptSync(password.normalize('NFC'), salt, keyBytes, options(N, r, p)));
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parse(stored: string): Parsed | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,10}$/.test(x) ? Number(x) : NaN));
  const { maxN, maxR, maxP } = STORED_HASH_LIMITS;
  if (!Number.isInteger(N) || N < 2 || N > maxN || (N & (N - 1)) !== 0) return undefined;
  if (!Number.isInteger(r) || r < 1 || r > maxR || !Number.isInteger(p) || p < 1 || p > maxP) return undefined;
  if (!B64URL.test(parts[4]) || !B64URL.test(parts[5])) return undefined;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || key.length < 32 || key.length > 128) return undefined;
  return { N, r, p, salt, key };
}

/**
 * True only if `password` hashes to `stored`. The key is compared with timingSafeEqual (equal lengths by
 * construction: the derived key is as long as the stored one). A malformed `stored` is false, never a throw.
 *
 * A password containing U+0000 is always false (after the same work): scrypt's PBKDF2-HMAC zero-pads short
 * keys, so 'secret' and 'secret\0' derive the SAME key. New passwords with control characters are refused
 * (src/auth/service.ts), so no stored hash ever comes from one.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parse(stored);
  if (!h) return false;
  let derived: Buffer;
  try {
    derived = await derive(password, h.salt, h.key.length, options(h.N, h.r, h.p));
  } catch {
    return false;
  }
  return timingSafeEqual(derived, h.key) && !password.includes('\u0000');
}

export const SCRYPT_HASHER: PasswordHasher = Object.freeze({
  hash: hashPassword,
  hashSync: hashPasswordSync,
  verify: verifyPassword,
});
