// src/auth/service.ts — the platform login's state: ONE account (admin), sign-in tokens, the brute-force
// backoff and the CSRF tokens of the login/logout/password forms. PLATFORM code: it guards the lab and
// must not be a vulnerability (docs/SECURITY.md "The platform login").
//
// Storage (platform DB, migrations 2 and 3, src/db/auth.sql + users.sql): users holds the scrypt hash only;
// auth_tokens holds the SHA-256 of each token, never the token (the browser's hvwa_auth cookie has it).
// The anonymous hvwa_sid is never touched: lab state, flags and the scoreboard stay keyed by it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SCRYPT_HASHER, type PasswordHasher } from './password.js';

export const ADMIN_USERNAME = 'admin';
/** The DVWA-style default, used when HVWA_ADMIN_PASSWORD is unset on first start. Change it after signing in. */
export const DEFAULT_ADMIN_PASSWORD = 'password';
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;
const USERNAME_MAX_LENGTH = 64;

/** The platform's auth cookie (RECIPES section 4: hvwa_* names are the platform's; labs never use them). */
export const AUTH_COOKIE = 'hvwa_auth';

export const AUTH_LIMITS = Object.freeze({
  /** Consecutive failures before the account locks. */
  freeFailures: 5,
  /** The first lock; each further failure doubles it... */
  lockBaseMs: 30_000,
  /** ...up to this. */
  lockCapMs: 15 * 60_000,
  /** A token's absolute lifetime (also the cookie's Max-Age). */
  tokenTtlMs: 12 * 60 * 60_000,
  /** A token unused this long is dead. */
  idleMs: 2 * 60 * 60_000,
  /** last_seen_at is written at most this often (not one DB write per request). */
  touchEveryMs: 60_000,
  /** Newest tokens kept per account (one per browser that signed in); older ones are revoked. */
  maxTokens: 20,
  /**
   * Password checks running at once. Every attempt costs one scrypt on libuv's thread pool (4 threads), a locked
   * or unknown-user one included (uniform timing), so a local flood could keep the pool busy for the whole app
   * (fs, dns, other crypto). 2 leave the rest of the pool free and hold at most 64 MiB of scrypt memory.
   */
  checksInFlight: 2,
  /** Attempts that may wait for a check slot; beyond them an attempt is refused at once (503), unchecked. */
  checksQueued: 8,
});

/** How long the account stays locked after its `failures`-th consecutive failure (0 = not locked). */
export function lockMsAfter(failures: number): number {
  const { freeFailures, lockBaseMs, lockCapMs } = AUTH_LIMITS;
  if (!(failures >= freeFailures)) return 0;
  const exp = failures - freeFailures;
  return exp >= 30 ? lockCapMs : Math.min(lockCapMs, lockBaseMs * 2 ** exp);
}

/** A token as minted: 32 random bytes, base64url (43 characters). Anything else is never looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthServiceOptions {
  /** Clock in ms (tokens, idle timeout, backoff). Default Date.now; tests inject a fake one. */
  now?: () => number;
  /** First password of the admin account, used only when no account exists yet. Default 'password'. */
  initialPassword?: string;
  /** Test seam: wraps the scrypt hasher (e.g. to count checks). Never set by server.ts. */
  hasher?: PasswordHasher;
}

export interface AuthSession { readonly username: string; readonly defaultPassword: boolean }

export type PasswordChangeError = 'current' | 'too_short' | 'too_long' | 'control' | 'mismatch' | 'same' | 'default' | 'busy';

/** C0 controls and DEL: never part of a new password (NUL would even collide in scrypt, see password.ts). */
const CONTROL = /[\u0000-\u001f\u007f]/;
export type PasswordChange = { ok: true; token: string } | { ok: false; error: PasswordChangeError };

export interface AuthService {
  /**
   * Sign in; on success a fresh token for the hvwa_auth cookie. Every credential failure is the same
   * `{ ok: false }`; `busy` means the attempt was refused unchecked because every check slot was taken.
   */
  signIn(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; busy?: true }>;
  /** The live session of a cookie value (touching it), or undefined for a missing, unknown or expired token. */
  session(token: unknown): AuthSession | undefined;
  /** Revoke one token (sign-out). Unknown tokens are ignored. */
  revoke(token: unknown): void;
  /** Change the password; on success EVERY token is revoked and a new one is minted for this browser. */
  changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange>;
  /** Whether the admin account still uses the default password (the banner, the startup warning). */
  usesDefaultPassword(): boolean;
  /** Password checks running and waiting right now (AUTH_LIMITS.checksInFlight / checksQueued). */
  checkLoad(): { inFlight: number; queued: number };
  /** Whether THIS start created the admin account (so `initialPassword` was used); false when it already existed. */
  readonly accountCreated: boolean;
  /**
   * A form's synchroniser token. The login form's is bound to hvwa_sid (the browser has no sign-in yet); the
   * account forms' (logout, password) also to the sign-in, `authToken` (the hvwa_auth cookie): any same-host page
   * on another port can plant an hvwa_sid and read the login page served to it, but it cannot know the sign-in.
   */
  csrfToken(sessionId: string, authToken?: string): string;
  /** Constant-time check of a submitted form token against the expected one (same arguments as csrfToken). */
  checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean;
}

interface AccountRow { username: string; password_hash: string; is_default: number; failures: number; locked_until: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * At most `max` jobs at once and `queueMax` waiting (FIFO); a job beyond that is not run at all. A finishing job
 * hands its slot straight to the next waiter, so the cap holds at every moment.
 */
function slots(max: number, queueMax: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    load: () => ({ inFlight: active, queued: waiting.length }),
    async run<T>(job: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
      if (active < max) active += 1;
      else if (waiting.length < queueMax) await new Promise<void>((resolve) => { waiting.push(resolve); });
      else return { ran: false };
      try {
        return { ran: true, value: await job() };
      } finally {
        const next = waiting.shift();
        if (next) next(); else active -= 1;
      }
    },
  };
}

/**
 * The login state over the platform DB. Creates the admin account on first use (no account yet) with
 * `initialPassword` or the default. Brute force: one scrypt check per attempt whatever happens (a dummy
 * hash for an unknown username or a locked account, so timing tells nothing); each attempt is counted as a
 * failure BEFORE the check, so a parallel burst cannot run more than `freeFailures` real checks; the fifth
 * consecutive failure locks the account (lockMsAfter), a success resets the count, and attempts while
 * locked are refused unchecked and do not extend the lock. The state lives in the DB (survives restarts).
 */
export function createAuthService(db: DatabaseSync, opts: AuthServiceOptions = {}): AuthService {
  const now = opts.now ?? Date.now;
  const hasher = opts.hasher ?? SCRYPT_HASHER;
  const csrfKey = randomBytes(32); // per process: a restart only expires open forms
  const checks = slots(AUTH_LIMITS.checksInFlight, AUTH_LIMITS.checksQueued);

  const getAccount = db.prepare(
    'SELECT username, password_hash, is_default, failures, locked_until FROM users WHERE username = ?');
  const setBackoff = db.prepare('UPDATE users SET failures = ?, locked_until = ? WHERE username = ?');
  const clearBackoff = db.prepare('UPDATE users SET failures = 0, locked_until = 0 WHERE username = ?');
  const insertToken = db.prepare(
    'INSERT INTO auth_tokens (token_hash, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)');
  const pruneTokens = db.prepare(`DELETE FROM auth_tokens WHERE username = ? AND (created_at <= ? OR last_seen_at <= ?
    OR rowid NOT IN (SELECT rowid FROM auth_tokens WHERE username = ? ORDER BY rowid DESC LIMIT ?))`);
  const findToken = db.prepare(`SELECT t.username, t.created_at, t.last_seen_at, a.is_default
    FROM auth_tokens t JOIN users a ON a.username = t.username WHERE t.token_hash = ?`);
  const touchToken = db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token_hash = ?');
  const deleteToken = db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?');
  const deleteAllTokens = db.prepare('DELETE FROM auth_tokens WHERE username = ?');
  const setPassword = db.prepare(`UPDATE users SET password_hash = ?, is_default = ?, failures = 0, locked_until = 0,
    changed_at = ? WHERE username = ?`);

  // First start: create the account. Synchronous (once), so the app never serves without one.
  const accountCreated = !getAccount.get(ADMIN_USERNAME);
  if (accountCreated) {
    const first = opts.initialPassword ?? DEFAULT_ADMIN_PASSWORD;
    if (first.length < PASSWORD_MIN_LENGTH || first.length > PASSWORD_MAX_LENGTH || CONTROL.test(first)) {
      // Never the value itself in the message.
      throw new Error(`auth: the initial password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters and no control characters`);
    }
    const t = now();
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at, is_default, failures, locked_until, changed_at)
      VALUES (?, ?, 'admin', ?, ?, 0, 0, ?)`).run(ADMIN_USERNAME, hasher.hashSync(first), t, first === DEFAULT_ADMIN_PASSWORD ? 1 : 0, t);
  }

  // Same cost as a real check: unknown usernames and locked attempts verify against this.
  const dummy = hasher.hash(randomBytes(32).toString('base64url'));
  dummy.catch(() => { /* surfaced on first use */ });

  const account = (username: string): AccountRow | undefined =>
    (username.length > USERNAME_MAX_LENGTH ? undefined : getAccount.get(username) as AccountRow | undefined);

  /** One password check under the backoff rules. Exactly one hasher.verify() call, whatever the outcome. */
  async function check(username: string, password: string): Promise<boolean> {
    const acct = account(username);
    const t = now();
    const open = acct !== undefined && t >= acct.locked_until; // a locked account is refused unchecked
    if (acct && open) {
      // Count the attempt as a failure up front (synchronously, before the first await), so concurrent
      // attempts see it; the fifth one locks. A success below clears it.
      const failures = acct.failures + 1;
      const lock = lockMsAfter(failures);
      setBackoff.run(failures, lock > 0 ? t + lock : 0, acct.username);
    }
    const real = acct !== undefined && open && password.length <= PASSWORD_MAX_LENGTH;
    const ok = await hasher.verify(real ? password : password.slice(0, PASSWORD_MAX_LENGTH), real ? acct.password_hash : await dummy);
    if (!ok || !real) return false;
    clearBackoff.run(acct.username);
    return true;
  }

  // Domain-separated: a login-form token is never an account-form token, nor one sign-in's another's.
  const csrfFor = (sessionId: string, authToken?: string) => createHmac('sha256', csrfKey)
    .update(authToken === undefined ? `hvwa-csrf:login:${sessionId}` : `hvwa-csrf:account:${sessionId}:${sha256(authToken)}`)
    .digest('base64url');

  function mint(username: string): string {
    const token = randomBytes(32).toString('base64url');
    const t = now();
    insertToken.run(sha256(token), username, t, t);
    pruneTokens.run(username, t - AUTH_LIMITS.tokenTtlMs, t - AUTH_LIMITS.idleMs, username, AUTH_LIMITS.maxTokens);
    return token;
  }

  return Object.freeze({
    async signIn(username: string, password: string) {
      const r = await checks.run(() => check(username, password));
      if (!r.ran) return { ok: false, busy: true } as const;
      if (!r.value) return { ok: false } as const;
      return { ok: true, token: mint(username) } as const;
    },

    session(token: unknown): AuthSession | undefined {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
      const hash = sha256(token);
      const row = findToken.get(hash) as
        { username: string; created_at: number; last_seen_at: number; is_default: number } | undefined;
      if (!row) return undefined;
      const t = now();
      if (t - row.created_at >= AUTH_LIMITS.tokenTtlMs || t - row.last_seen_at >= AUTH_LIMITS.idleMs) {
        deleteToken.run(hash);
        return undefined;
      }
      if (t - row.last_seen_at >= AUTH_LIMITS.touchEveryMs) touchToken.run(t, hash);
      return { username: row.username, defaultPassword: row.is_default === 1 };
    },

    revoke(token: unknown): void {
      if (typeof token === 'string' && TOKEN_RE.test(token)) deleteToken.run(sha256(token));
    },

    async changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange> {
      if (next.length < PASSWORD_MIN_LENGTH) return { ok: false, error: 'too_short' };
      if (next.length > PASSWORD_MAX_LENGTH) return { ok: false, error: 'too_long' };
      if (CONTROL.test(next)) return { ok: false, error: 'control' };
      if (next !== confirm) return { ok: false, error: 'mismatch' };
      if (next === current) return { ok: false, error: 'same' };
      if (next === DEFAULT_ADMIN_PASSWORD) return { ok: false, error: 'default' };
      // The check and the new hash share one slot: both are scrypt.
      const r = await checks.run(async () => ((await check(username, current)) ? hasher.hash(next) : undefined));
      if (!r.ran) return { ok: false, error: 'busy' };
      if (r.value === undefined) return { ok: false, error: 'current' };
      setPassword.run(r.value, 0, now(), username);
      deleteAllTokens.run(username);
      return { ok: true, token: mint(username) };
    },

    usesDefaultPassword(): boolean {
      return account(ADMIN_USERNAME)?.is_default === 1;
    },

    checkLoad: () => checks.load(),
    accountCreated,

    csrfToken: csrfFor,

    checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean {
      if (typeof submitted !== 'string') return false;
      const expected = Buffer.from(csrfFor(sessionId, authToken));
      const got = Buffer.from(submitted);
      return got.length === expected.length && timingSafeEqual(got, expected);
    },
  });
}
