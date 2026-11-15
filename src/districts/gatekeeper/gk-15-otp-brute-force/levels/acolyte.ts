import { rotateCode, type Cookies, type LabState, type Reply } from '../model.js';

// ACOLYTE — no defense. A 4-digit code has only 10 000 values, and nothing limits how
// many of them you may try: wrong guesses are not counted at all.
export function gate(_state: LabState, _username: string): Reply {
  return { ok: true, message: 'A code was sent to the account owner.' };
}

export function verify(state: LabState, code: string, _cookies: Cookies): Reply {
  if (code !== state.otp) return { ok: false, message: 'Incorrect code.' };
  return { ok: true, message: 'Code accepted.' };
}

export function resend(state: LabState, _cookies: Cookies): Reply {
  rotateCode(state);
  return { ok: true, message: 'A new code was sent.' };
}
