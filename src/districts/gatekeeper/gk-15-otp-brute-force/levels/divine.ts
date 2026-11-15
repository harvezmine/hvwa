import { timingSafeEqual } from 'node:crypto';
import { rotateCode, type Cookies, type LabState, type Reply } from '../model.js';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_RESENDS = 3;
const LOCKED: Reply = { ok: false, message: 'Too many attempts. Try again later.' };

// DIVINE — secure reference for OTP guessing. Failures are counted on the SERVER, per
// account, and do not reset on a resend or a new sign-in: 5 wrong codes lock the account
// for 15 minutes, and a locked account cannot even start a new sign-in. Resend issues a
// genuinely new code (the old one dies) and is capped; a code lives 5 minutes and works
// once. Nothing the client sends (cookies, headers) can change a counter.
// Out of scope here: a production system would use a longer code or an authenticator app,
// notify the account owner of lockouts, and rate-limit by device as well as by account.
function counterOf(state: LabState, user: string) {
  const c = state.counters.get(user) ?? { failures: 0, lockedUntil: 0 };
  if (c.lockedUntil !== 0 && c.lockedUntil <= state.now()) { c.failures = 0; c.lockedUntil = 0; } // lock served
  state.counters.set(user, c);
  return c;
}

export function gate(state: LabState, username: string): Reply {
  if (counterOf(state, username).lockedUntil > state.now()) return LOCKED;
  return { ok: true, message: 'A code was sent to the account owner.' };
}

export function verify(state: LabState, code: string, _cookies: Cookies): Reply {
  const user = state.pending ?? '';
  const c = counterOf(state, user);
  if (c.lockedUntil > state.now()) return LOCKED;
  if (state.now() - state.issuedAt > CODE_TTL_MS) return { ok: false, message: 'Code expired. Request a new code.' };

  const given = Buffer.from(code);
  const live = Buffer.from(state.otp);
  if (!/^\d{4}$/.test(code) || given.length !== live.length || !timingSafeEqual(given, live)) {
    c.failures += 1;
    if (c.failures >= MAX_FAILURES) { c.lockedUntil = state.now() + LOCK_MS; return LOCKED; }
    return { ok: false, message: 'Incorrect code.' };
  }
  c.failures = 0;
  state.otp = ''; // single use
  return { ok: true, message: 'Code accepted.' };
}

export function resend(state: LabState, _cookies: Cookies): Reply {
  if (counterOf(state, state.pending ?? '').lockedUntil > state.now()) return LOCKED;
  if (state.resends >= MAX_RESENDS) return { ok: false, message: 'Too many resend requests. Sign in again later.' };
  state.resends += 1;
  rotateCode(state); // the old code stops working; failures are NOT reset
  return { ok: true, message: 'A new code was sent.' };
}
