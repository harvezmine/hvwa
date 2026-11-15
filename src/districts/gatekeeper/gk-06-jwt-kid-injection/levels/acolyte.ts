import { posix } from 'node:path';
import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Guard, LabState, Verdict } from '../model.js';

export const kid = 'k1.key';

// ACOLYTE — the key is a FILE named by the token: `kid` is joined onto /keys/ and normalized, and the
// file's bytes become the HMAC secret. Nothing keeps the result inside /keys/, so "../" reaches any other
// file, and an attacker only needs one whose contents they know (an empty /dev/null, a public robots.txt).
// (The files live in the lab's simulated file system, state.files, never on the real disk.)
export function verify(state: LabState, token: string, _guard: Guard): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (typeof t.header.kid !== 'string') return { ok: false, reason: 'missing key id' };
  const path = posix.normalize(`/keys/${t.header.kid}`);
  const secret = state.files.get(path);
  if (secret === undefined) return { ok: false, reason: `no such key file ${path}` };
  if (hmacSignature('HS256', secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
