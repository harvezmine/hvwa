import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// ACOLYTE — the verifier believes the token's own header: whatever `alg` it names is what gets "checked",
// and the algorithm "none" means "no signature". An attacker simply names it.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  if (alg === 'none') return { ok: true, claims: t.payload }; // unsecured JWT: nothing to check
  if (alg === 'HS256') {
    if (hmacSignature('HS256', state.secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: false, reason: 'unsupported algorithm' };
}
