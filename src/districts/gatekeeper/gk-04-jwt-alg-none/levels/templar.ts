import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// TEMPLAR — a blacklist: the exact string "none" is refused. But the verifier's algorithm dispatch
// is case-insensitive (it upper-cases the name first), so "NONE" or "None" still lands on the
// "unsecured token" branch and skips the signature.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  if (typeof alg !== 'string') return { ok: false, reason: 'unsupported algorithm' };
  if (alg === 'none') return { ok: false, reason: 'unsecured tokens are not accepted' };
  switch (alg.toUpperCase()) {
    case 'NONE':
      return { ok: true, claims: t.payload };
    case 'HS256':
      if (hmacSignature('HS256', state.secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
      return { ok: false, reason: 'bad signature' };
    default:
      return { ok: false, reason: 'unsupported algorithm' };
  }
}
