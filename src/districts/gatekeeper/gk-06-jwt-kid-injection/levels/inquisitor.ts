import { hmacSignature, parseToken } from '../../_shared/jwt.js';
import type { Guard, LabState, Verdict } from '../model.js';

export const kid = 'k1';

// INQUISITOR — no file paths any more: keys live in a table. But the key id is pasted into the SQL text,
// so a quote breaks out of the string and a UNION SELECT returns a key of the attacker's choosing.
// Verbosity: a database error is shown below Divine (guard is tryDb); Divine has no database at all.
export function verify(state: LabState, token: string, guard: Guard): Verdict {
  let t;
  try { t = parseToken(token); } catch { return { ok: false, reason: 'malformed token' }; }
  if (t.header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };
  const id = t.header.kid;
  if (typeof id !== 'string') return { ok: false, reason: 'missing key id' };
  const sql = `SELECT secret FROM keys WHERE kid = '${id}'`; // the flaw: the key id is concatenated
  const found = guard(() => state.db().prepare(sql).get() as { secret?: unknown } | undefined);
  if (!found.ok) return { ok: false, reason: found.message };
  if (found.value === undefined) return { ok: false, reason: 'unknown key id' };
  const s = found.value.secret;
  const secret = typeof s === 'string' || s instanceof Uint8Array ? s : String(s);
  if (hmacSignature('HS256', secret, t.signingInput) === t.signature) return { ok: true, claims: t.payload };
  return { ok: false, reason: 'bad signature' };
}
