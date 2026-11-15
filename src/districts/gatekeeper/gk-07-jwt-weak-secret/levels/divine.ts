import { randomBytes } from 'node:crypto';
import { hmacSignature, parseToken, safeEqual } from '../../_shared/jwt.js';
import type { Keys, LabState, Verdict } from '../model.js';

export const kid = undefined;

// DIVINE — secure reference: one key of 256 random bits from the OS CSPRNG (nothing to crack), no legacy or
// retired keys, `kid` is not trusted to select anything (it is never read), the algorithm is pinned and the
// signature is compared in constant time.
// Verbosity: the reasons below are shown below Divine only; challenge.ts answers a bare "Invalid token."
// here. Out of scope: expiry, key rotation (which would retire keys by deleting them, never by leaving them
// accepted) and keeping the key in a secret store rather than in memory.
export function createKeys(_words: readonly string[]): Keys {
  return { secret: randomBytes(32).toString('hex') };
}

export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (!safeEqual(hmacSignature('HS256', state.secret, t.signingInput), t.signature)) return { ok: false, reason: 'bad signature' };
  return { ok: true, claims: t.payload };
}
