import type { LabState, LoginOutcome } from '../model.js';
import { accounts } from '../model.js';

const MAX_FAILURES = 5;
const MAX_COUNTERS = 1000; // a real name has few spellings; this only bounds memory
const LOCK_MS = 15 * 60_000; // long enough that waiting is not the practical way through the list

// INQUISITOR — real defense, subtly wrong: failures are counted per username and a
// success only clears its own counter, but the counter is keyed on the username
// exactly as typed, while the login itself matches case-insensitively. "citadel_admin",
// "Citadel_admin" and "CITADEL_ADMIN" are one account with three separate counters.
export function login(state: LabState, username: string, password: string): LoginOutcome {
  const now = state.now();
  const counter = state.counters.get(username) ?? { failures: 0, lockedUntil: 0 };
  if (counter.lockedUntil > now) return { ok: false, message: 'Account locked. Try again later.' };
  if (counter.lockedUntil !== 0) { counter.failures = 0; counter.lockedUntil = 0; } // lock expired

  const account = accounts(state).find((a) => a.username.toLowerCase() === username.toLowerCase());
  if (account && account.password === password) {
    state.counters.delete(username);
    return { ok: true, account };
  }
  if (account) { // only real accounts are tracked (bounded: one counter per spelling of a real name)
    counter.failures += 1;
    if (counter.failures >= MAX_FAILURES) counter.lockedUntil = now + LOCK_MS;
    state.counters.set(username, counter);
    if (state.counters.size > MAX_COUNTERS) state.counters.delete(state.counters.keys().next().value as string);
  }
  return { ok: false, message: 'Invalid username or password.' };
}
