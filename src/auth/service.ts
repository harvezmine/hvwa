// src/auth/service.ts — the platform login's state: the accounts (users: the admin alone in standalone mode, the admin
// and every registered player in portal mode), sign-in tokens, the brute-force backoff, the password-check cap and the
// CSRF tokens of the platform forms. PLATFORM code: it guards the labs and must not be a vulnerability
// (docs/SECURITY.md "The platform login").
//
// Storage (platform DB, migrations 2 and 3, src/db/auth.sql + users.sql): users holds the scrypt hash only;
// auth_tokens holds the SHA-256 of each token, never the token (the browser's hvwa_auth cookie has it). In standalone
// mode lab state, flags and the scoreboard stay keyed by hvwa_sid; in portal mode the range keys progress by users.id
// (src/range/progress.ts).
//
// Compact POC (plan amendment, spec §16): roles and `disabled` are honoured everywhere here (a disabled account cannot
// sign in and loses its sessions), but there are no admin operations (disable, reset password, make admin).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SCRYPT_HASHER, type PasswordHasher } from './password.js';

export const ADMIN_USERNAME = 'admin';
/** The DVWA-style default, used when HVWA_ADMIN_PASSWORD is unset on first start. Change it after signing in. */
export const DEFAULT_ADMIN_PASSWORD = 'password';
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;
const USERNAME_MAX_LENGTH = 64;
/** A registered username (spec range §4): 3 to 24 of [a-z0-9_]. register() lower-cases what was typed first. */
export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const ROLES = Object.freeze(['player', 'admin'] as const);
export type Role = (typeof ROLES)[number];
export function isRole(x: unknown): x is Role {
  return x === 'player' || x === 'admin';
}

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
   * Password checks (and hashes) running at once. Every attempt costs one scrypt on libuv's thread pool (4 threads), a
   * locked or unknown-user one included (uniform timing), and so does every registration, so a flood could keep the
   * pool busy for the whole app. 2 leave the rest of the pool free and hold at most 64 MiB of scrypt.
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
  /** Clock in ms (tokens, idle timeout, backoff, created_at). Default Date.now; tests inject a fake one. */
  now?: () => number;
  /** First password of the admin account, used only when no admin account exists yet. Default 'password'. */
  initialPassword?: string;
  /** Test seam: wraps the scrypt hasher (e.g. to count checks). Never set by server.ts. */
  hasher?: PasswordHasher;
  /** The shortest NEW password (change, registration). Default PASSWORD_MIN_LENGTH; portal mode passes 10 (spec §4). */
  passwordMinLength?: number;
}

export interface AuthSession {
  readonly userId: number;
  readonly username: string;
  readonly role: Role;
  /** A password someone else chose is in use: the default one (the banner). */
  readonly defaultPassword: boolean;
}

export interface UserSummary {
  readonly id: number;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly disabled: boolean;
}

export type PasswordChangeError = 'current' | 'too_short' | 'too_long' | 'control' | 'mismatch' | 'same' | 'default' | 'busy';

/** C0 controls and DEL: never part of a new password (NUL would even collide in scrypt, see password.ts). */
const CONTROL = /[\u0000-\u001f\u007f]/;
export type PasswordChange = { ok: true; token: string } | { ok: false; error: PasswordChangeError };
export type RegisterError = 'username' | 'taken' | 'too_short' | 'too_long' | 'control' | 'mismatch' | 'limited' | 'busy';
export type Registration = { ok: true; userId: number } | { ok: false; error: RegisterError };

export interface AuthService {
  /**
   * Sign in; on success a fresh token for the hvwa_auth cookie. Every credential failure (a disabled account included)
   * is the same `{ ok: false }`; `busy` means the attempt was refused unchecked because every check slot was taken.
   */
  signIn(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; busy?: true }>;
  /** The live session of a cookie value (touching it), or undefined for a missing, unknown, expired or disabled one. */
  session(token: unknown): AuthSession | undefined;
  /** Revoke one token (sign-out). Unknown tokens are ignored. */
  revoke(token: unknown): void;
  /** Change the password; on success EVERY token of the account is revoked and a new one is minted for this browser. */
  changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange>;
  /** Whether the admin account still uses the default password (the startup warning). */
  usesDefaultPassword(): boolean;
  /** Password checks running and waiting right now (AUTH_LIMITS.checksInFlight / checksQueued). */
  checkLoad(): { inFlight: number; queued: number };
  /** Whether THIS start created the admin account (so `initialPassword` was used); false when it already existed. */
  readonly accountCreated: boolean;
  /** The shortest new password this service accepts (the views' minlength and help text). */
  readonly passwordMinLength: number;
  /**
   * A form's synchroniser token. The login and registration forms' is bound to hvwa_sid (the browser has no sign-in
   * yet); the account forms' (logout, password and range actions) also to the sign-in, `authToken` (the hvwa_auth
   * cookie): any same-host page can plant an hvwa_sid and read a page served to it, but not the sign-in.
   */
  csrfToken(sessionId: string, authToken?: string): string;
  /** Constant-time check of a submitted form token against the expected one (same arguments as csrfToken). */
  checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean;
  /**
   * Create a player (portal mode's /register). The username is trimmed and lower-cased, then must match USERNAME_RE
   * and be free whatever its case; the password follows passwordMinLength. `admit` (the per-IP limit) is asked after
   * every cheap check and right before the hash, under the same check slots as a sign-in.
   */
  register(username: string, password: string, confirm: string, admit?: () => boolean): Promise<Registration>;
  /** This account exists and is not disabled (the range's gate, forward-auth and launches). */
  isActive(userId: number): boolean;
  /** Every account, by id. */
  listUsers(): UserSummary[];
  getUser(id: number): UserSummary | undefined;
}

interface AccountRow {
  id: number; username: string; password_hash: string; role: string; disabled: number;
  is_default: number; failures: number; locked_until: number;
}
interface UserRow { id: number; username: string; role: string; created_at: number; disabled: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const summary = (r: UserRow): UserSummary => ({
  id: Number(r.id), username: r.username, role: isRole(r.role) ? r.role : 'player',
  createdAt: Number(r.created_at), disabled: r.disabled === 1,
});

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
 * The login state over the platform DB. Creates the admin account on first use (no admin yet) with `initialPassword`
 * or the default. Brute force: one password check per attempt whatever happens (a dummy hash for an unknown username,
 * a locked or a disabled account, so timing tells nothing); each attempt is counted as a failure BEFORE the check, so
 * a parallel burst cannot run more than `freeFailures` real checks; the fifth consecutive failure locks the account
 * (lockMsAfter), a success resets the count, attempts while locked are refused unchecked and do not extend the lock.
 */
export function createAuthService(db: DatabaseSync, opts: AuthServiceOptions = {}): AuthService {
  const now = opts.now ?? Date.now;
  const hasher = opts.hasher ?? SCRYPT_HASHER;
  const minLength = opts.passwordMinLength ?? PASSWORD_MIN_LENGTH;
  if (!Number.isInteger(minLength) || minLength < PASSWORD_MIN_LENGTH || minLength > 128) {
    throw new Error(`auth: passwordMinLength must be an integer from ${PASSWORD_MIN_LENGTH} to 128`);
  }
  const csrfKey = randomBytes(32); // per process: a restart only expires open forms
  const checks = slots(AUTH_LIMITS.checksInFlight, AUTH_LIMITS.checksQueued);

  const getAccount = db.prepare(
    'SELECT id, username, password_hash, role, disabled, is_default, failures, locked_until FROM users WHERE username = ?');
  const getUserRow = db.prepare('SELECT id, username, role, created_at, disabled FROM users WHERE id = ?');
  const nameTaken = db.prepare('SELECT 1 AS taken FROM users WHERE username = ? COLLATE NOCASE');
  const listAll = db.prepare('SELECT id, username, role, created_at, disabled FROM users ORDER BY id');
  const insertUser = db.prepare(`INSERT INTO users (username, password_hash, role, created_at, disabled, is_default,
    failures, locked_until, changed_at) VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?)`);
  const setBackoff = db.prepare('UPDATE users SET failures = ?, locked_until = ? WHERE username = ?');
  const clearBackoff = db.prepare('UPDATE users SET failures = 0, locked_until = 0 WHERE username = ?');
  const insertToken = db.prepare(
    'INSERT INTO auth_tokens (token_hash, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)');
  const pruneTokens = db.prepare(`DELETE FROM auth_tokens WHERE username = ? AND (created_at <= ? OR last_seen_at <= ?
    OR rowid NOT IN (SELECT rowid FROM auth_tokens WHERE username = ? ORDER BY rowid DESC LIMIT ?))`);
  const findToken = db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.is_default, t.created_at, t.last_seen_at
    FROM auth_tokens t JOIN users u ON u.username = t.username WHERE t.token_hash = ?`);
  const touchToken = db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token_hash = ?');
  const deleteToken = db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?');
  const deleteAllTokens = db.prepare('DELETE FROM auth_tokens WHERE username = ?');
  const setPassword = db.prepare(`UPDATE users SET password_hash = ?, is_default = ?, failures = 0, locked_until = 0,
    changed_at = ? WHERE username = ?`);

  // First start: create the admin. Synchronous (once), so the app never serves without one.
  const accountCreated = !getAccount.get(ADMIN_USERNAME);
  if (accountCreated) {
    const first = opts.initialPassword ?? DEFAULT_ADMIN_PASSWORD;
    if (first.length < PASSWORD_MIN_LENGTH || first.length > PASSWORD_MAX_LENGTH || CONTROL.test(first)) {
      // Never the value itself in the message.
      throw new Error(`auth: the initial password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters and no control characters`);
    }
    const t = now();
    insertUser.run(ADMIN_USERNAME, hasher.hashSync(first), 'admin', t, first === DEFAULT_ADMIN_PASSWORD ? 1 : 0, t);
  }

  // Same cost as a real check: unknown usernames, locked and disabled accounts verify against this.
  const dummy = hasher.hash(randomBytes(32).toString('base64url'));
  dummy.catch(() => { /* surfaced on first use */ });

  const account = (username: string): AccountRow | undefined =>
    (username.length > USERNAME_MAX_LENGTH ? undefined : getAccount.get(username) as AccountRow | undefined);
  const user = (id: number): UserSummary | undefined => {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    const row = getUserRow.get(id) as UserRow | undefined;
    return row ? summary(row) : undefined;
  };

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
    const real = acct !== undefined && open && acct.disabled === 0 && password.length <= PASSWORD_MAX_LENGTH;
    const ok = await hasher.verify(real ? password : password.slice(0, PASSWORD_MAX_LENGTH), real ? acct.password_hash : await dummy);
    if (!ok || !real) return false;
    clearBackoff.run(acct.username);
    return true;
  }

  const newPasswordError = (next: string): 'too_short' | 'too_long' | 'control' | undefined =>
    (next.length < minLength ? 'too_short' : next.length > PASSWORD_MAX_LENGTH ? 'too_long' : CONTROL.test(next) ? 'control' : undefined);

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
      const row = findToken.get(hash) as {
        id: number; username: string; role: string; disabled: number; is_default: number; created_at: number; last_seen_at: number;
      } | undefined;
      if (!row) return undefined;
      const t = now();
      if (row.disabled === 1 || t - row.created_at >= AUTH_LIMITS.tokenTtlMs || t - row.last_seen_at >= AUTH_LIMITS.idleMs) {
        deleteToken.run(hash);
        return undefined;
      }
      if (t - row.last_seen_at >= AUTH_LIMITS.touchEveryMs) touchToken.run(t, hash);
      return {
        userId: Number(row.id), username: row.username, role: isRole(row.role) ? row.role : 'player',
        defaultPassword: row.is_default === 1,
      };
    },

    revoke(token: unknown): void {
      if (typeof token === 'string' && TOKEN_RE.test(token)) deleteToken.run(sha256(token));
    },

    async changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange> {
      const bad = newPasswordError(next);
      if (bad) return { ok: false, error: bad };
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
    passwordMinLength: minLength,

    csrfToken: csrfFor,

    checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean {
      if (typeof submitted !== 'string') return false;
      const expected = Buffer.from(csrfFor(sessionId, authToken));
      const got = Buffer.from(submitted);
      return got.length === expected.length && timingSafeEqual(got, expected);
    },

    async register(rawUsername: string, password: string, confirm: string, admit?: () => boolean): Promise<Registration> {
      const username = rawUsername.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return { ok: false, error: 'username' };
      const bad = newPasswordError(password);
      if (bad) return { ok: false, error: bad };
      if (password !== confirm) return { ok: false, error: 'mismatch' };
      if (nameTaken.get(username)) return { ok: false, error: 'taken' };
      if (admit && !admit()) return { ok: false, error: 'limited' };
      const r = await checks.run(() => hasher.hash(password));
      if (!r.ran) return { ok: false, error: 'busy' };
      const t = now();
      try {
        const info = insertUser.run(username, r.value, 'player', t, 0, t);
        return { ok: true, userId: Number(info.lastInsertRowid) };
      } catch (err) {
        if (/UNIQUE constraint failed/.test(String(err))) return { ok: false, error: 'taken' }; // a concurrent twin
        throw err;
      }
    },

    isActive(userId: number): boolean {
      const u = user(userId);
      return u !== undefined && !u.disabled;
    },

    listUsers: () => (listAll.all() as unknown as UserRow[]).map(summary),
    getUser: user,
  });
}
