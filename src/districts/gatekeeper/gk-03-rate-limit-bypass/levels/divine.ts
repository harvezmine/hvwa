import { accounts, isLimited, readCreds, record, type Attempt, type LabState, type Outcome } from '../model.js';

const SOCKET_MAX = 20;
const LIMITED = 'Too many attempts. Try again later.';

// DIVINE — secure reference: two independent limits, and no client-supplied header is
// ever consulted. (1) The TCP peer address gets a budget of attempts per window, so one
// client cannot spray many accounts. (2) Each real account, found by its normalized
// username, has its own budget of FAILED attempts, so a guesser who somehow changes
// address still cannot get more tries at one account. One request is one credential
// pair: an array body (batching) is refused before anything is counted or checked.
// Only real accounts get a bucket, so made-up names cannot grow or flush the table.
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

  const accountKey = `acct:${account.username}`;
  if (isLimited(state, accountKey)) return { ok: false, message: LIMITED };
  if (account.password !== password) {
    record(state, accountKey);
    return { ok: false, message: 'Invalid username or password.' };
  }
  return { ok: true, account };
}
