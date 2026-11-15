import { posix } from 'node:path';
import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Guard, LabState, Verdict } from '../model.js';

export const kid = 'k1.key';

// TEMPLAR — a filter: every "../" is removed from the key id, once. The removal is not repeated, so a
// string that BECOMES "../" after one pass ("....//" is "../" with another "../" hidden inside) survives it.
// (The files live in the lab's simulated file system, state.files, never on the real disk.)
export function verify(state: LabState, token: string, _guard: Guard): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  if (typeof t.header.kid !== 'string') return { ok: false, reason: 'missing key id' };
  const cleaned = t.header.kid.replaceAll('../', ''); // one pass only
  const path = posix.normalize(`/keys/${cleaned}`);
  const secret = state.files.get(path);
  if (secret === undefined) return { ok: false, reason: `no such key file ${path}` };
  if (hmacSignature('HS256', secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
