import { accounts, isLimited, readCreds, record, type Attempt, type LabState, type Outcome } from '../model.js';

const SOCKET_MAX = 20;
const FREE_FAILURES = 5;
const BASE_LOCK_MS = 30 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;
const LIMITED = 'Too many attempts. Try again later.';

// DIVINE — secure reference: two independent limits, and no client-supplied header is
// ever consulted. (1) The TCP peer address gets a budget of attempts per window, so one
// client cannot spray many accounts. (2) Each real account, found by its normalized
// username, has its own count of FAILED attempts: the fifth failure locks it for 30 minutes
// and every further failure doubles the lock (up to a day), so waiting out a window buys
// one guess, not five. One request is one credential pair: an array body (batching) is
// refused before anything is counted or checked. Only real accounts get a counter, so
// made-up names cannot grow or flush the table.
// Out of scope here: behind a real reverse proxy the peer address would be the proxy's,
// so a deployment must configure trusted proxies explicitly; real systems also add
// CAPTCHAs, MFA and alerting.
export function login(state: LabState, attempt: Attempt): Outcome {
  if (Array.isArray(attempt.body)) return { ok: false, message: 'Batch requests are not accepted.' };

  const socketKey = `ip:${attempt.socketAddress}`;
  if (isLimited(state, socketKey, SOCKET_MAX)) return { ok: false, message: LIMITED };
  record(state, socketKey);

  const { username, password } = readCreds(attempt.body);
  const name = username.normalize('NFKC').trim().toLowerCase();
  const account = accounts(state).find((a) => a.username === name);
  if (!account) return { ok: false, message: 'Invalid username or password.' };

  const now = state.now();
  const counter = state.counters.get(account.username) ?? { failures: 0, lockedUntil: 0 };
  if (counter.lockedUntil > now) return { ok: false, message: LIMITED };

  if (account.password !== password) {
    counter.failures += 1;
    if (counter.failures >= FREE_FAILURES) {
      counter.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** (counter.failures - FREE_FAILURES), MAX_LOCK_MS);
    }
    state.counters.set(account.username, counter);
    return { ok: false, message: 'Invalid username or password.' };
  }
  state.counters.delete(account.username);
  return { ok: true, account };
}
