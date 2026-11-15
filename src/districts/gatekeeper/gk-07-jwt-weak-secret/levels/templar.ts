import { randomInt } from 'node:crypto';
import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Keys, LabState, Verdict } from '../model.js';

export const kid = undefined;

// TEMPLAR — "mangled" is not strong: the secret is a wordlist word plus two digits. That is only 100 times
// the work of a plain word, which a script finishes in a blink. (Mangling rules are the first thing a
// cracker tries after the bare wordlist.)
export function createKeys(words: readonly string[]): Keys {
  return { secret: `${words[randomInt(words.length)]}${String(randomInt(100)).padStart(2, '0')}` };
}

export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (hmacSignature('HS256', state.secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
