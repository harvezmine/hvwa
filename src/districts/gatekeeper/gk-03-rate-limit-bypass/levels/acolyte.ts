import { accounts, isLimited, readCreds, record, type Attempt, type LabState, type Outcome } from '../model.js';

// ACOLYTE — the limiter identifies the client by the X-Forwarded-For header, taken
// verbatim. That header is written by the client: every new value is a new "client"
// with a fresh budget of attempts. (Without the header it falls back to the socket.)
export function login(state: LabState, attempt: Attempt): Outcome {
  const key = attempt.forwardedFor ?? attempt.socketAddress;
  if (isLimited(state, key)) return { ok: false, message: 'Too many attempts. Try again in a minute.' };
  record(state, key);

  const { username, password } = readCreds(attempt.body);
  const account = accounts(state).find((a) => a.username === username);
  if (!account || account.password !== password) return { ok: false, message: 'Invalid username or password.' };
  return { ok: true, account };
}
