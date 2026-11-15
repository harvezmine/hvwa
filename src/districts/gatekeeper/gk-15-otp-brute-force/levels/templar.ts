import type { Cookies, LabState, Reply } from '../model.js';

const MAX_ATTEMPTS = 5;
const LIMITED: Reply = { ok: false, message: 'Too many attempts. Request a new code.' };

// TEMPLAR — naive limit: 5 wrong codes and the step is refused until you "request a new
// code". The flaw: resend zeroes the counter but does NOT issue a different code, so the
// same secret can be guessed again, five tries at a time, forever.
export function gate(_state: LabState, _username: string, _cookies: Cookies): Reply {
  // Signing in again does NOT clear the counter: only "resend" does (the flaw below).
  return { ok: true, message: 'A code was sent to the account owner.' };
}

export function verify(state: LabState, code: string, _cookies: Cookies): Reply {
  const user = state.pending ?? '';
  const counter = state.counters.get(user) ?? { failures: 0, lockedUntil: 0 };
  if (counter.failures >= MAX_ATTEMPTS) return LIMITED;
  if (code !== state.otp) {
    counter.failures += 1;
    state.counters.set(user, counter);
    return { ok: false, message: 'Incorrect code.' };
  }
  return { ok: true, message: 'Code accepted.' };
}

export function resend(state: LabState, _cookies: Cookies): Reply {
  state.counters.delete(state.pending ?? ''); // "fresh start" ... with the same code
  return { ok: true, message: 'A new code was requested. Your attempts were reset.' };
}
