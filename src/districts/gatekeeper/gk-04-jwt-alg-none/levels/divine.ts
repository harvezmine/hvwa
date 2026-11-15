import { hmacSignature, parseToken, safeEqual } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// DIVINE — secure reference: the algorithm is pinned server-side (the header is only checked against it,
// never believed), a signature is always required, and it is compared in constant time.
// Verbosity: the reasons below are shown below Divine only; challenge.ts answers a bare "Invalid token."
// here. Out of scope: expiry (`exp`), audience/issuer checks, key rotation and revocation.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (t.signature === '') return { ok: false, reason: 'signature required' };
  if (!safeEqual(hmacSignature('HS256', state.secret, t.signingInput), t.signature)) return { ok: false, reason: 'bad signature' };
  return { ok: true, claims: t.payload };
}
