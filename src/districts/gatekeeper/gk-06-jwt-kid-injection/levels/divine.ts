import { hmacSignature, parseToken, safeEqual } from '../../_shared/jwt.js';
import type { Guard, LabState, Verdict } from '../model.js';

export const kid = 'k1';

// DIVINE — secure reference: `kid` is only ever compared with a fixed allowlist of key ids; it is never
// joined into a path nor put into a query. An unknown id is refused, the algorithm is pinned and the
// signature is compared in constant time.
// Verbosity: the reasons below are shown below Divine only; challenge.ts answers a bare "Invalid token."
// here. Out of scope: expiry, rotation of k1, and loading keys from a real secret store.
const ALLOWED_KIDS: ReadonlySet<string> = new Set(['k1']);

export function verify(state: LabState, token: string, _guard: Guard): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  const id = t.header.kid;
  if (typeof id !== 'string' || !ALLOWED_KIDS.has(id)) return { ok: false, reason: 'unknown key id' };
  if (!safeEqual(hmacSignature('HS256', state.signingKey, t.signingInput), t.signature)) return { ok: false, reason: 'bad signature' };
  return { ok: true, claims: t.payload };
}
