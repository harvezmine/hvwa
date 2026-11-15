import type { LabState, LoginOutcome } from '../model.js';
import { accounts } from '../model.js';

const MAX_FAILURES = 5;
const LOCK_MS = 30_000;

// TEMPLAR — naive defense: after 5 failures a username is locked, and the failure
// message is uniform. The flaw: ANY successful login (your own account will do)
// clears every failure counter, so failures can be spread between "good" logins.
export function login(state: LabState, username: string, password: string): LoginOutcome {
  const now = state.now();
  const counter = state.counters.get(username) ?? { failures: 0, lockedUntil: 0 };
  if (counter.lockedUntil > now) return { ok: false, message: 'Account locked. Try again later.' };
  if (counter.lockedUntil !== 0) { counter.failures = 0; counter.lockedUntil = 0; } // lock expired

  const account = accounts(state).find((a) => a.username === username);
  if (account && account.password === password) {
    state.counters.clear(); // success: forget all failures
    return { ok: true, account };
  }
  if (account) { // only real usernames are tracked
    counter.failures += 1;
    if (counter.failures >= MAX_FAILURES) counter.lockedUntil = now + LOCK_MS;
    state.counters.set(username, counter);
  }
  return { ok: false, message: 'Invalid username or password.' };
}
