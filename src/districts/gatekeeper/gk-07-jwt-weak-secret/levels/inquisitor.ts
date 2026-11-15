import { randomBytes, randomInt } from 'node:crypto';
import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Keys, LabState, Verdict } from '../model.js';

export const kid = '2025';
export const legacyKid = '2024';

// INQUISITOR — the current key (kid 2025) is strong, and keys rotate by `kid`. But the retired 2024 key was
// never switched off: it is still accepted, it was a wordlist word, and an old token signed with it sits in
// the published release notes: a perfect cracking target for a key that still opens the vault.
export function createKeys(words: readonly string[]): Keys {
  return { secret: randomBytes(32).toString('hex'), legacySecret: words[randomInt(words.length)] };
}

export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  let secret: string | undefined;
  if (t.header.kid === kid) secret = state.secret;
  else if (t.header.kid === legacyKid) secret = state.legacySecret; // "still accepted while clients migrate"
  if (secret === undefined) return { ok: false, reason: 'unknown key id' };
  if (hmacSignature('HS256', secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
