import { createPublicKey, type KeyObject } from 'node:crypto';
import { isRsaAlg, parseToken, rsaVerify } from '../../_shared/jwt.js';
import type { LabState, Verdict } from '../model.js';

// INQUISITOR — the algorithm family is pinned: only RS256/384/512, no HMAC at all. The flaw is the key:
// "self-describing tokens" may carry their own verification key in the header (`jwk`), and the verifier
// trusts it. An attacker generates a key pair, signs with it, and embeds the public half.
export function verify(state: LabState, token: string): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  const alg = t.header.alg;
  if (!isRsaAlg(alg)) return { ok: false, reason: 'unsupported algorithm' };
  try {
    let key: string | KeyObject = state.publicPem;
    const jwk = t.header.jwk;
    if (jwk !== undefined) {
      if (jwk === null || typeof jwk !== 'object' || Array.isArray(jwk)) return { ok: false, reason: 'bad jwk' };
      key = createPublicKey({ key: jwk as Record<string, string>, format: 'jwk' }); // trusts the token's own key
    }
    if (rsaVerify(alg, key, t.signingInput, t.signature)) return { ok: true, claims: t.payload };
    return { ok: false, reason: 'bad signature' };
  } catch {
    return { ok: false, reason: 'bad jwk' };
  }
}
