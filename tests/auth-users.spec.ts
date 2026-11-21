// The login generalised to many users (src/auth/service.ts, spec range §4): registration rules, roles and disabled
// accounts, on the same backoff, check cap, tokens and CSRF as the single-admin login. Compact POC (plan amendment):
// roles and `disabled` are in the schema and the service, but there are no admin operations (disable, reset password,
// make admin), so `disabled` is set straight in the DB here.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService, USERNAME_RE, type AuthServiceOptions } from '../src/auth/service.js';
import type { PasswordHasher } from '../src/auth/password.js';
import { FAST_HASHER } from './helpers.js';

const T0 = Date.UTC(2026, 10, 20, 9);
const PW = 'Player-Pass-1';
const ADMIN_PW = 'Admin-Pass-1234';
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

function make(opts: AuthServiceOptions = {}) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = T0;
  const service = createAuthService(db, { hasher: FAST_HASHER, now: () => t, initialPassword: ADMIN_PW, passwordMinLength: 10, ...opts });
  return { db, service, advance: (ms: number) => { t += ms; } };
}
async function token(service: ReturnType<typeof make>['service'], username: string, password: string): Promise<string> {
  const r = await service.signIn(username, password);
  if (!r.ok) throw new Error(`sign-in of ${username} failed`);
  return r.token;
}
const setDisabled = (db: DatabaseSync, username: string, disabled: boolean) =>
  db.prepare('UPDATE users SET disabled = ? WHERE username = ?').run(disabled ? 1 : 0, username);

describe('register', () => {
  it('creates a player from a lower-cased username; it signs in and its session carries id and role', async () => {
    const { service } = make();
    expect(await service.register('  Alice_01 ', PW, PW)).toEqual({ ok: true, userId: 2 });
    expect(service.getUser(2)).toEqual({ id: 2, username: 'alice_01', role: 'player', createdAt: T0, disabled: false });
    expect(service.session(await token(service, 'alice_01', PW)))
      .toEqual({ userId: 2, username: 'alice_01', role: 'player', defaultPassword: false });
    expect(service.session(await token(service, 'admin', ADMIN_PW)))
      .toEqual({ userId: 1, username: 'admin', role: 'admin', defaultPassword: false });
    expect(service.listUsers().map((u) => [u.id, u.username, u.role])).toEqual([[1, 'admin', 'admin'], [2, 'alice_01', 'player']]);
  });

  it.each([
    ['ab', 'username'], ['a'.repeat(25), 'username'], ['al ice', 'username'], ['alice-1', 'username'],
    ['alicé', 'username'], ['', 'username'], ['admin', 'taken'], ['ADMIN', 'taken'],
  ] as const)('refuses the username %j (%s)', async (name, error) => {
    const { service } = make();
    expect(await service.register(name, PW, PW)).toEqual({ ok: false, error });
    expect(service.listUsers()).toHaveLength(1);
  });

  it('USERNAME_RE is exactly 3 to 24 of [a-z0-9_]', () => {
    expect(['abc', 'a_1', 'x'.repeat(24)].every((n) => USERNAME_RE.test(n))).toBe(true);
    expect(['ab', 'x'.repeat(25), 'ABC', 'a.b', 'a-b'].some((n) => USERNAME_RE.test(n))).toBe(false);
  });

  it('password rules: passwordMinLength (10 here), at most 1024, no control characters, both entries equal', async () => {
    const { service } = make();
    expect(await service.register('bob', 'Short-pw1', 'Short-pw1')).toEqual({ ok: false, error: 'too_short' });
    expect(await service.register('bob', 'x'.repeat(1025), 'x'.repeat(1025))).toEqual({ ok: false, error: 'too_long' });
    expect(await service.register('bob', 'Player\u0000Pass1', 'Player\u0000Pass1')).toEqual({ ok: false, error: 'control' });
    expect(await service.register('bob', PW, `${PW}x`)).toEqual({ ok: false, error: 'mismatch' });
    expect(await service.register('bob', PW, PW)).toMatchObject({ ok: true });
  });

  it('admit() is asked after validation and before hashing: false means "limited" and nothing is created', async () => {
    const hashed: string[] = [];
    const hasher: PasswordHasher = { ...FAST_HASHER, hash: async (p) => { hashed.push(p); return FAST_HASHER.hash(p); } };
    const { service } = make({ hasher });
    const before = hashed.length; // the dummy hash made at start-up
    let asked = 0;
    expect(await service.register('ab', PW, PW, () => { asked += 1; return true; })).toEqual({ ok: false, error: 'username' });
    expect(asked).toBe(0);
    expect(await service.register('carol', PW, PW, () => false)).toEqual({ ok: false, error: 'limited' });
    expect(hashed.length).toBe(before);
    expect(service.listUsers().map((u) => u.username)).toEqual(['admin']);
  });

  it('two registrations of one name at once: one account, the other is "taken"', async () => {
    const { service } = make();
    const results = await Promise.all([service.register('dave', PW, PW), service.register('DAVE', PW, PW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'taken' }]);
  });
});

describe('disabled accounts (the column is kept; no admin operation sets it in the POC)', () => {
  it('a disabled account loses its sessions and is refused with the uniform failure (still one password check)', async () => {
    let verifies = 0;
    const hasher: PasswordHasher = { ...FAST_HASHER, verify: async (p, s) => { verifies += 1; return FAST_HASHER.verify(p, s); } };
    const { db, service } = make({ hasher });
    const { userId } = await service.register('erin', PW, PW) as { ok: true; userId: number };
    const erinToken = await token(service, 'erin', PW);
    expect(service.isActive(userId)).toBe(true);
    setDisabled(db, 'erin', true);
    expect(service.session(erinToken)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM auth_tokens WHERE username = ?').get('erin')).toEqual({ n: 0 }); // dropped
    expect(service.isActive(userId)).toBe(false);
    expect(service.getUser(userId)).toMatchObject({ disabled: true });
    const n = verifies;
    expect(await service.signIn('erin', PW)).toEqual({ ok: false });
    expect(verifies).toBe(n + 1);
    setDisabled(db, 'erin', false);
    expect(service.isActive(userId)).toBe(true);
    expect(service.session(await token(service, 'erin', PW))).toMatchObject({ username: 'erin' });
  });

  it('unknown and malformed ids are never active and have no user', () => {
    const { service } = make();
    expect(service.isActive(1)).toBe(true);
    for (const id of [99, 0, -1, 1.5, Number.NaN]) {
      expect(service.isActive(id), String(id)).toBe(false);
      expect(service.getUser(id), String(id)).toBeUndefined();
    }
  });
});

describe('passwordMinLength', () => {
  it('a password change follows passwordMinLength (10 in portal mode); the default is 8; below 8 is refused', async () => {
    const { service } = make();
    expect(await service.changePassword('admin', ADMIN_PW, 'Nine-char', 'Nine-char')).toEqual({ ok: false, error: 'too_short' });
    expect(service.passwordMinLength).toBe(10);
    expect(make({ passwordMinLength: undefined }).service.passwordMinLength).toBe(8);
    expect(() => make({ passwordMinLength: 4 })).toThrow(/passwordMinLength/);
  });
});
