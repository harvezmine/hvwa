import { accounts, isLimited, readCreds, record, type Attempt, type LabState, type Outcome } from '../model.js';

const MAX_BATCH = 50;

// INQUISITOR — real defense, subtly wrong: the limiter keys on the TCP peer address,
// which a client cannot spoof, and no header is trusted. But the endpoint also accepts
// a JSON array of credential pairs ("bulk sign-in") and counts the whole request as ONE
// attempt, so a single request can carry up to 50 guesses.
export function login(state: LabState, attempt: Attempt): Outcome {
  const key = attempt.socketAddress;
  if (isLimited(state, key)) return { ok: false, message: 'Too many attempts. Try again in a minute.' };
  record(state, key); // one request = one attempt, however many pairs it carries

  const pairs = Array.isArray(attempt.body) ? attempt.body.slice(0, MAX_BATCH).map(readCreds) : [readCreds(attempt.body)];
  for (const { username, password } of pairs) {
    const account = accounts(state).find((a) => a.username === username);
    if (account && account.password === password) return { ok: true, account };
  }
  return { ok: false, message: 'Invalid username or password.' };
}
