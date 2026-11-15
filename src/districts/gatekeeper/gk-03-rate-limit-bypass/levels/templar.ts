import { accounts, isLimited, readCreds, record, type Attempt, type LabState, type Outcome } from '../model.js';

// TEMPLAR — naive fix: X-Forwarded-For is no longer believed, but a different
// "real client address" header, X-Real-IP, still is. It is just as client-written,
// so the same trick works with the other header name.
export function login(state: LabState, attempt: Attempt): Outcome {
  const key = attempt.realIp ?? attempt.socketAddress;
  if (isLimited(state, key)) return { ok: false, message: 'Too many attempts. Try again in a minute.' };
  record(state, key);

  const { username, password } = readCreds(attempt.body);
  const account = accounts(state).find((a) => a.username === username);
  if (!account || account.password !== password) return { ok: false, message: 'Invalid username or password.' };
  return { ok: true, account };
}
