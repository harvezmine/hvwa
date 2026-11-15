import { hmacSignature, isHmacAlg, isRsaAlg, parseToken, rsaVerify } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// TEMPLAR — a blacklist: the exact name "HS256" is refused. The other HMAC sizes are still accepted, and
// still use the public-key PEM as their shared secret: the confusion is the same, one letter away.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  const key = state.publicPem;
  if (alg === 'HS256') return { ok: false, reason: 'HS256 is not accepted' };
  if (isHmacAlg(alg)) {
    if (hmacSignature(alg, key, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
    return { ok: false, reason: 'bad signature' };
  }
  if (isRsaAlg(alg)) {
    if (rsaVerify(alg, key, t.signingInput, t.signature)) return { ok: true, claims: t.payload };
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: false, reason: 'unsupported algorithm' };
}
