import { randomInt } from 'node:crypto';
import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Keys, LabState, Verdict } from '../model.js';

export const kid = undefined;

// ACOLYTE — the HMAC secret is one random word from the published wordlist. The verification itself is
// fine; the secret is not: a few hundred guesses against any token the server issued (offline, no
// rate limit) recover it, and then any token can be forged.
export function createKeys(words: readonly string[]): Keys {
  return { secret: words[randomInt(words.length)] };
}

export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (hmacSignature('HS256', state.secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
