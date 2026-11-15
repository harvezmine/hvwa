import { hmacSignature, isHmacAlg, isRsaAlg, parseToken, rsaVerify } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// ACOLYTE — the algorithm is taken from the token's own header, and one "key" variable serves every
// algorithm. Tokens are RS256, so that key is the PUBLIC key; for an HS* token the verifier hands the very
// same PEM text to the HMAC as its shared secret. The public key is, well, public (./public.pem).
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  const key = state.publicPem;
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
