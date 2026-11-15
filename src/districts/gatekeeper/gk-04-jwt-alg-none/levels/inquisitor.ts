import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// INQUISITOR — every spelling of "none" is refused and only HS256 is allowed. The flaw is one step
// later: a token whose signature segment is EMPTY is treated as an "unsigned preview token" and
// waved through before any comparison happens.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  if (typeof alg === 'string' && /^none$/i.test(alg)) return { ok: false, reason: 'unsecured tokens are not accepted' };
  if (alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (t.signature === '') return { ok: true, claims: t.payload }; // "preview tokens carry no signature"
  if (hmacSignature('HS256', state.secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
