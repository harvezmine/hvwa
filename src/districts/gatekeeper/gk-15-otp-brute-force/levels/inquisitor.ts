import { rotateCode, type Cookies, type LabState, type Reply } from '../model.js';

const MAX_ATTEMPTS = 5;
const COUNTER = 'otp_attempts';

// INQUISITOR — real defense, subtly wrong: the code is rotated on resend and 5 wrong
// attempts block the step, but the attempt counter is kept in a plain cookie the server
// trusts as sent. It is not signed and not tied to anything on the server, so a client
// that deletes it, or sets it back to 0, gets its attempts back.
function attemptsIn(cookies: Cookies): number {
  const raw = cookies[COUNTER];
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function gate(_state: LabState, _username: string, cookies: Cookies): Reply {
  // Start the counter only when the client has none: signing in again must not hand attempts back.
  const cookie = cookies[COUNTER] === undefined ? { [COUNTER]: '0' } : undefined;
  return { ok: true, message: 'A code was sent to the account owner.', cookies: cookie };
}

export function verify(state: LabState, code: string, cookies: Cookies): Reply {
  const attempts = attemptsIn(cookies);
  if (attempts >= MAX_ATTEMPTS) return { ok: false, message: 'Too many attempts. Request a new code.' };
  if (code !== state.otp) return { ok: false, message: 'Incorrect code.', cookies: { [COUNTER]: String(attempts + 1) } };
  return { ok: true, message: 'Code accepted.' };
}

export function resend(state: LabState, _cookies: Cookies): Reply {
  rotateCode(state); // a new code; the counter (client side) is left alone
  return { ok: true, message: 'A new code was sent.' };
}
