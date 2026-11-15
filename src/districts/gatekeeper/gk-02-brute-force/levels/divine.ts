import type { LabState, LoginOutcome } from '../model.js';
import { accounts } from '../model.js';

const FREE_FAILURES = 5;
const BASE_LOCK_MS = 30 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

// DIVINE — secure reference for brute force: the username is normalized ONCE and that
// one form is used both to find the account and to key the counter. Every failure past
// the fifth doubles the lockout (exponential backoff, capped), and every failure,
// unknown user, wrong password or locked account, gets the same message, so nothing
// tells a guesser which usernames exist or when a lock applies. A locked account
// rejects even the correct password. Only real accounts are tracked, so the counter
// map cannot be grown (or flushed) with made-up names.
// Out of scope here: a production system would also hash passwords slowly, alert on
// repeated lockouts and add a second factor.
const UNIFORM = 'Invalid username or password.';

export function login(state: LabState, username: string, password: string): LoginOutcome {
  const key = username.normalize('NFKC').trim().toLowerCase();
  const account = accounts(state).find((a) => a.username === key);
  if (!account) return { ok: false, message: UNIFORM };

  const now = state.now();
  const counter = state.counters.get(key) ?? { failures: 0, lockedUntil: 0 };
  if (counter.lockedUntil > now) return { ok: false, message: UNIFORM };

  if (account.password === password) {
    state.counters.delete(key);
    return { ok: true, account };
  }
  counter.failures += 1;
  if (counter.failures >= FREE_FAILURES) {
    const lock = Math.min(BASE_LOCK_MS * 2 ** (counter.failures - FREE_FAILURES), MAX_LOCK_MS);
    counter.lockedUntil = now + lock;
  }
  state.counters.set(key, counter);
  return { ok: false, message: UNIFORM };
}
