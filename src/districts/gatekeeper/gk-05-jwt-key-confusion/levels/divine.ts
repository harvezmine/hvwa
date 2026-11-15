import { parseToken, rsaVerify } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// DIVINE — secure reference: RS256 only, and the verification key comes only from the server's own keystore.
// Header fields that name or carry a key (`jwk`, `jku`, `kid`, `x5c` ...) are never read. HMAC is not even a
// code path here, so the public key can never become a secret.
// Verbosity: the reasons below are shown below Divine only; challenge.ts answers a bare "Invalid token."
// here. Out of scope: expiry, audience/issuer checks, key rotation and a `kid`-based keystore.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'RS256') return { ok: false, reason: 'unsupported algorithm' };
  if (!rsaVerify('RS256', state.publicPem, t.signingInput, t.signature)) return { ok: false, reason: 'bad signature' };
  return { ok: true, claims: t.payload };
}
