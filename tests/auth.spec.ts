// The platform login (src/auth): createApp({ auth }) puts every route but /login, /healthz and the static
// assets behind one admin account. This is PLATFORM code: it must not be a vulnerability. Auth is OFF for
// every other spec (tests/support/setup.ts pins HVWA_AUTH=off); these specs turn it on explicitly.
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type HvwaApp } from '../src/app.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { perSession } from '../src/core/lab.js';
import { issueFlag } from '../src/core/flags.js';
import { AUTH_LIMITS } from '../src/auth/service.js';
import { SCRYPT_HASHER, type PasswordHasher } from '../src/auth/password.js';
import { TEST_SECRET, setCookieHeader, setCookieValue } from './helpers.js';

// A stateful lab keyed by hvwa_sid (perSession), to prove lab progress survives sign-in and sign-out.
const counters = perSession(() => ({ n: 0 }));
register(defineChallenge({
  id: 'ZA-01', district: 'auth-test', slug: 'counter', dir: process.cwd(), title: { id: 'Counter', en: 'Counter' },
  summary: { id: '', en: '' }, maps: ['x'], levels: ['acolyte', 'divine'], hints: [{ id: 1, cost: 10, text: { id: 'h', en: 'h' } }],
  mount: (r) => {
    r.get('/', (req, res) => { res.type('text').send('lab'); });
    r.post('/hit', (req, res) => { const c = counters.for(req); c.n += 1; res.json({ n: c.n }); });
  },
}));

const T0 = Date.UTC(2026, 10, 17, 12);
const tempDirs: string[] = [];
const apps: HvwaApp[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) { try { a.locals.db.close(); } catch { /* closed by the test */ } }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** With `hold`, every password check waits until the test calls one of `releases` (to fill the check slots). */
interface Held { releases: (() => void)[]; inFlight: number; peak: number }
interface Made { app: HvwaApp; clock: { now: () => number; advance: (ms: number) => void }; verifies: string[]; held: Held }
/** An auth-on app with a fake clock; `verifies` records which stored hash each password check used. */
function authApp(o: { initialPassword?: string; dbPath?: string; hold?: boolean } = {}): Made {
  let t = T0;
  const verifies: string[] = [];
  const held: Held = { releases: [], inFlight: 0, peak: 0 };
  const hasher: PasswordHasher = {
    ...SCRYPT_HASHER,
    verify: async (pw, stored) => {
      verifies.push(stored);
      held.inFlight += 1;
      held.peak = Math.max(held.peak, held.inFlight);
      try {
        if (o.hold) await new Promise<void>((r) => { held.releases.push(r); });
        return await SCRYPT_HASHER.verify(pw, stored);
      } finally {
        held.inFlight -= 1;
      }
    },
  };
  const app = createApp({
    flagSecret: TEST_SECRET, dbPath: o.dbPath,
    auth: { now: () => t, hasher, ...(o.initialPassword === undefined ? {} : { initialPassword: o.initialPassword }) },
  });
  apps.push(app);
  return { app, clock: { now: () => t, advance: (ms) => { t += ms; } }, verifies, held };
}

const csrfOf = (html: string): string => {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
};
type Agent = ReturnType<typeof request.agent>;

/**
 * This browser's LOGIN-form token (bound to hvwa_sid alone). A signed-in browser is sent on from /login, so its
 * login token is read from the login page served to its hvwa_sid without the auth cookie (an old open tab).
 */
async function csrfFor(agent: Agent): Promise<string> {
  const page = await agent.get('/login');
  if (page.status === 200) return csrfOf(page.text);
  const server = (agent as unknown as { app: Parameters<typeof request>[0] }).app;
  return csrfOf((await request(server).get('/login').set('Cookie', `hvwa_sid=${sidOf(agent)}`)).text);
}
/** This signed-in browser's ACCOUNT-form token (logout, password; bound to hvwa_sid AND its hvwa_auth). */
async function accountCsrf(agent: Agent): Promise<string> {
  return csrfOf((await agent.get('/account/password')).text);
}

/** GET /login (establishes hvwa_sid), then POST the form with this browser's token. */
async function signIn(agent: Agent, fields: { username?: string; password?: string; next?: string } = {}) {
  const _csrf = await csrfFor(agent); // first: an agent attaches its cookies when the request is created
  return agent.post('/login').type('form').send({
    _csrf, username: fields.username ?? 'admin', password: fields.password ?? 'password',
    ...(fields.next === undefined ? {} : { next: fields.next }),
  });
}
const authCookie = (res: request.Response) => setCookieValue(res, 'hvwa_auth');

/** A fresh browser that is signed in; returns it with its auth token. */
async function signedIn(app: HvwaApp, password = 'password') {
  const agent = request.agent(app);
  const res = await signIn(agent, { password });
  expect(res.status, res.text).toBe(303);
  const token = authCookie(res);
  expect(token).toBeDefined();
  return { agent, token: token as string };
}
/** The hvwa_sid in an agent's cookie jar. */
function sidOf(agent: Agent): string {
  const jar = (agent as unknown as { jar: { getCookie(n: string, o: unknown): { value: string } | undefined } }).jar;
  const c = jar.getCookie('hvwa_sid', { domain: '127.0.0.1', path: '/', secure: false, script: false });
  if (!c) throw new Error('agent has no hvwa_sid');
  return c.value;
}
/** Requests carrying exactly these cookies (no jar), like curl -b. */
const withCookies = (app: HvwaApp, cookie: string) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookie),
  post: (url: string) => request(app).post(url).set('Cookie', cookie),
});

describe('the gate (auth on)', () => {
  it('sends a signed-out browser to /login?next=<path> with a 303, from every route', async () => {
    const { app } = authApp();
    for (const path of ['/', '/scoreboard', '/c/ZA-01', '/c/ZA-01?lang=en', '/d/auth-test/counter?level=acolyte',
      '/account/password', '/no-such-page', '/c/ZA-01/source/acolyte']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.location, path).toBe(`/login?next=${encodeURIComponent(path)}`);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
    // A form post (no htmx) is sent to the login page too, back to / afterwards.
    const post = await request(app).post('/c/ZA-01/submit').type('form').send({ submission: 'x' });
    expect(post.status).toBe(303);
    expect(post.headers.location).toBe('/login?next=%2F');
  });

  it('leaves /login, /healthz and the static assets open', async () => {
    const { app } = authApp();
    expect((await request(app).get('/login')).status).toBe(200);
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    const css = await request(app).get('/static/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect((await request(app).get('/static/vendor/htmx.min.js')).status).toBe(200);
    // ...but nothing else under /static: a missing asset is behind the gate like any page.
    expect((await request(app).get('/static/nope.css')).status).toBe(303);
  });

  it('answers the JSON API with 401 JSON instead of a redirect', async () => {
    const { app } = authApp();
    const submit = await request(app).post('/api/submit').send({ challengeId: 'ZA-01', submission: 'x' });
    expect(submit.status).toBe(401);
    expect(submit.body).toEqual({ error: 'unauthorized' });
    expect(submit.headers.location).toBeUndefined();
    for (const [m, p] of [['post', '/api/hint'], ['get', '/api'], ['get', '/api/anything'], ['get', '/API/submit']] as const) {
      const res = await request(app)[m](p);
      expect(res.status, p).toBe(401);
      expect(res.body, p).toEqual({ error: 'unauthorized' });
    }
  });

  it('answers an htmx request with 401 + HX-Redirect to the login page, back to the page it came from', async () => {
    const { app } = authApp();
    const res = await request(app).post('/c/ZA-01/submit').set('Host', '127.0.0.1').set('HX-Request', 'true')
      .set('HX-Current-URL', 'http://127.0.0.1/c/ZA-01?lang=en').type('form').send({ submission: 'x' });
    expect(res.status).toBe(401);
    expect(res.headers['hx-redirect']).toBe(`/login?next=${encodeURIComponent('/c/ZA-01?lang=en')}`);
    // HX-Current-URL is client input: another origin, or an unsafe path, falls back to /.
    for (const current of ['http://evil.example/c/ZA-01', 'http://127.0.0.1//evil.example', 'not a url']) {
      const r = await request(app).post('/c/ZA-01/hint').set('Host', '127.0.0.1').set('HX-Request', 'true')
        .set('HX-Current-URL', current).type('form').send({ tier: '1' });
      expect(r.status, current).toBe(401);
      expect(r.headers['hx-redirect'], current).toBe('/login?next=%2F');
    }
  });

  it('accepts the token from the hvwa_auth cookie only: never from the URL, a header or the body', async () => {
    const { app } = authApp();
    const { token } = await signedIn(app);
    expect((await withCookies(app, `hvwa_auth=${token}`).get('/')).status).toBe(200);
    expect((await request(app).get(`/?hvwa_auth=${token}`)).status).toBe(303);
    expect((await request(app).get(`/?token=${token}`)).status).toBe(303);
    expect((await request(app).get('/').set('Authorization', `Bearer ${token}`)).status).toBe(303);
    expect((await request(app).get('/').set('X-HVWA-Auth', token)).status).toBe(303);
    expect((await request(app).post('/api/submit').send({ hvwa_auth: token, challengeId: 'ZA-01' })).status).toBe(401);
  });

  it('refuses forged, malformed and stale tokens and clears the cookie', async () => {
    const { app } = authApp();
    for (const bad of ['x', 'A'.repeat(43), `${'A'.repeat(42)}=`, 'A'.repeat(44), '%00', '']) {
      const res = await withCookies(app, `hvwa_auth=${bad}`).get('/');
      expect(res.status, bad).toBe(303);
      expect(setCookieHeader(res, 'hvwa_auth'), bad).toMatch(/^hvwa_auth=; Path=\/; Expires=Thu, 01 Jan 1970/);
    }
  });
});

describe('signing in', () => {
  it('the login page is bilingual (EN default), carries a CSRF token and the validated next', async () => {
    const { app } = authApp();
    const id = await request(app).get('/login?next=%2Fc%2FZA-01&lang=id');
    expect(id.status).toBe(200);
    expect(id.headers['cache-control']).toBe('no-store');
    expect(id.headers['x-frame-options']).toBe('DENY');
    expect(id.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(id.text).toContain('<html lang="id">');
    expect(id.text).toContain('Kata sandi');
    expect(id.text).toContain('name="next" value="/c/ZA-01"');
    expect(csrfOf(id.text)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id.text).toContain('autocomplete="current-password"');
    const en = await request(app).get('/login'); // no ?lang=, no cookie: English
    expect(en.text).toContain('<html lang="en">');
    expect(en.text).toContain('Password');
    // The signed-out page shows no navigation into the gated portal, and never the default password.
    expect(id.text).not.toContain('href="/scoreboard"');
    expect(id.text).not.toMatch(/admin\s*\/\s*password/);
  });

  it('admin / password signs in: 303 to next, a fresh hvwa_auth cookie, the portal opens', async () => {
    const { app } = authApp();
    const agent = request.agent(app);
    const res = await signIn(agent, { next: '/c/ZA-01?lang=en' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/c/ZA-01?lang=en');
    expect(authCookie(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const portal = await agent.get('/');
    expect(portal.status).toBe(200);
    expect(portal.text).toContain('data-district="auth-test"');
    expect(portal.text).toContain('data-testid="account-nav"');
    // Already signed in: GET /login goes straight on.
    const again = await agent.get('/login?next=%2Fscoreboard');
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe('/scoreboard');
  });

  it('mints a NEW random token at every sign-in and revokes the one the browser presented', async () => {
    const { app } = authApp();
    const { agent, token: first } = await signedIn(app);
    const res = await signIn(agent);
    const second = authCookie(res) as string;
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect((await withCookies(app, `hvwa_auth=${first}`).get('/')).status).toBe(303);
    expect((await withCookies(app, `hvwa_auth=${second}`).get('/')).status).toBe(200);
    const other = await signedIn(app); // another browser: its own token, the first browser keeps its own
    expect(other.token).not.toBe(second);
    expect((await withCookies(app, `hvwa_auth=${second}`).get('/')).status).toBe(200);
  });

  it('sets hvwa_auth with explicit attributes: HttpOnly, SameSite=Lax, Path=/, Max-Age; no Domain', async () => {
    const { app } = authApp();
    const res = await signIn(request.agent(app));
    const line = setCookieHeader(res, 'hvwa_auth') ?? '';
    const ttl = AUTH_LIMITS.tokenTtlMs / 1000;
    expect(line).toMatch(new RegExp(`^hvwa_auth=[A-Za-z0-9_-]{43}; Max-Age=${ttl}; Path=/; Expires=[^;]+; HttpOnly; SameSite=Lax$`));
    expect(line).not.toMatch(/domain=/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('every failure gets ONE uniform message (wrong password, unknown user, blank, oversized, odd bodies)', async () => {
    const { app } = authApp();
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const bodies: string[] = [];
    for (const fields of [
      { username: 'admin', password: 'wrong-password' },
      { username: 'nobody', password: 'password' },
      { username: 'Admin', password: 'password' },
      { username: 'admin ', password: 'password' },
      { username: '', password: '' },
      { username: 'admin', password: 'x'.repeat(5000) },
      { username: 'a'.repeat(500), password: 'password' },
      { 'username[]': 'admin', password: 'password' },
      { username: 'admin', 'password[x]': 'password' },
    ]) {
      const res = await agent.post('/login').type('form').send({ _csrf: csrf, next: '/scoreboard', ...fields });
      expect(res.status, JSON.stringify(fields)).toBe(401);
      expect(authCookie(res)).toBeUndefined();
      expect(res.text).toContain('data-testid="login-error"');
      bodies.push(res.text);
    }
    expect(new Set(bodies).size).toBe(1); // byte-identical pages: nothing tells the cases apart
    expect(bodies[0]).toContain('name="next" value="/scoreboard"');
    expect(bodies[0]).not.toContain('wrong-password');
  });

  it('runs exactly one password check per attempt: a dummy hash for an unknown username', async () => {
    const { app, verifies } = authApp();
    const stored = (app.locals.db.prepare("SELECT password_hash h FROM users WHERE username='admin'").get() as { h: string }).h;
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    await agent.post('/login').type('form').send({ _csrf: csrf, username: 'nobody', password: 'password' });
    await agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password: 'wrong-pass' });
    await agent.post('/login').type('form').send({ _csrf: csrf, username: '', password: '' });
    expect(verifies).toHaveLength(3);
    expect(verifies[0]).not.toBe(stored); // the dummy...
    expect(verifies[0]).toMatch(/^scrypt\$/); // ...a real scrypt hash with the same cost
    expect(verifies[1]).toBe(stored);
    expect(verifies[2]).toBe(verifies[0]);
  });

  it('never logs the password', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { app } = authApp({ initialPassword: 'Env-Secret-123' });
      await signIn(request.agent(app), { password: 'Env-Secret-123' });
      await signIn(request.agent(app), { password: 'Typo-Secret-123' });
      const logged = JSON.stringify(spies.map((s) => s.mock.calls));
      expect(logged).not.toContain('Env-Secret-123');
      expect(logged).not.toContain('Typo-Secret-123');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

/** Release held checks (one per tick, so each freed slot is handed on) until `until` settles; returns its value. */
async function drain<T>(held: Held, until: Promise<T>): Promise<T> {
  let settled = false;
  const out = until.finally(() => { settled = true; });
  const deadline = Date.now() + 15_000;
  while (!settled) {
    if (Date.now() > deadline) throw new Error('held checks never finished');
    held.releases.shift()?.();
    await new Promise((r) => setTimeout(r, 2));
  }
  return out;
}

describe('password checks in flight (CPU: every attempt, even a locked one, costs one scrypt)', () => {
  it(`runs at most ${AUTH_LIMITS.checksInFlight} at once, queues ${AUTH_LIMITS.checksQueued}, and answers 503 beyond: no check, no backoff`, async () => {
    const { app, verifies, held } = authApp({ hold: true });
    const db = app.locals.db;
    const agent = request.agent(app);
    const csrf = await csrfFor(agent);
    const attempt = (username: string) => agent.post('/login').type('form').send({ _csrf: csrf, username, password: 'wrong-pass', next: '/c/ZA-01' });
    const capacity = AUTH_LIMITS.checksInFlight + AUTH_LIMITS.checksQueued;
    const done: request.Response[] = [];
    const all = Array.from({ length: capacity }, () => attempt('nobody').then((r) => { done.push(r); return r; }));
    const full = { inFlight: AUTH_LIMITS.checksInFlight, queued: AUTH_LIMITS.checksQueued };
    await vi.waitFor(() => {
      expect(app.locals.auth?.checkLoad()).toEqual(full);
      expect(held.releases).toHaveLength(AUTH_LIMITS.checksInFlight); // both in-flight checks reached scrypt
    }, { timeout: 10_000 });
    // Full: three more (for the real account) are refused at once, before any check or backoff bookkeeping.
    const busy = await Promise.all([attempt('admin'), attempt('admin'), attempt('admin')]);
    for (const r of busy) {
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('1');
      expect(r.text).toContain('data-testid="auth-busy"');
      expect(r.text).toContain('name="next" value="/c/ZA-01"');
      expect(r.text).not.toContain('data-testid="login-error"');
    }
    expect(done).toHaveLength(0);
    expect(verifies).toHaveLength(AUTH_LIMITS.checksInFlight);
    expect(db.prepare("SELECT failures FROM users WHERE username='admin'").get()).toEqual({ failures: 0 });
    expect(app.locals.auth?.checkLoad()).toEqual(full);
    // Release one check at a time: each frees its slot for the next queued attempt, never more than the cap.
    const results = await drain(held, Promise.all(all));
    expect(app.locals.auth?.checkLoad()).toEqual({ inFlight: 0, queued: 0 });
    expect(held.peak).toBe(AUTH_LIMITS.checksInFlight);
    expect(verifies).toHaveLength(capacity); // every admitted attempt: exactly one check
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(new Set(results.map((r) => r.text)).size).toBe(1); // admitted ones stay uniform
  });

  it('the password form is capped too: 503, nothing changed', async () => {
    const { app, held } = authApp({ hold: true });
    const me = request.agent(app);
    expect((await drain(held, signIn(me))).status).toBe(303);
    const _csrf = await accountCsrf(me);
    const other = request.agent(app);
    const otherCsrf = await csrfFor(other);
    const fill = Array.from({ length: AUTH_LIMITS.checksInFlight + AUTH_LIMITS.checksQueued }, () =>
      other.post('/login').type('form').send({ _csrf: otherCsrf, username: 'nobody', password: 'x' }).then((r) => r));
    await vi.waitFor(() => expect(app.locals.auth?.checkLoad())
      .toEqual({ inFlight: AUTH_LIMITS.checksInFlight, queued: AUTH_LIMITS.checksQueued }), { timeout: 10_000 });
    const res = await me.post('/account/password').type('form')
      .send({ _csrf, current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.text).toContain('data-testid="auth-busy"');
    await drain(held, Promise.all(fill));
    expect((await drain(held, signIn(request.agent(app)))).status).toBe(303); // the old password still works
  });
});

describe('brute-force backoff (fake clock)', () => {
  it('locks the account after 5 failures; even the right password is refused, with the same message, until it expires', async () => {
    const { app, clock, verifies } = authApp();
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const attempt = (password: string) => agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password });
    const uniform = (await attempt('wrong-1')).text;
    for (let i = 2; i <= 5; i++) expect((await attempt(`wrong-${i}`)).status).toBe(401);
    const checked = verifies.length;
    const locked = await attempt('password');
    expect(locked.status).toBe(401);
    expect(locked.text).toBe(uniform);
    expect(verifies.length).toBe(checked + 1); // still one (dummy) check: a locked attempt costs the same
    clock.advance(AUTH_LIMITS.lockBaseMs - 1);
    expect((await attempt('password')).status).toBe(401);
    clock.advance(1);
    expect((await attempt('password')).status).toBe(303);
  });

  it('grows the lock exponentially with every further failure, capped, and a success resets it', async () => {
    const { app, clock } = authApp();
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const attempt = (password: string) => agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password });
    for (let i = 0; i < 5; i++) await attempt('wrong');
    const expectLocked = async (ms: number) => {
      clock.advance(ms - 1);
      expect((await attempt('password')).status, `locked for ${ms} ms`).toBe(401);
      clock.advance(1);
    };
    await expectLocked(30_000);
    await attempt('wrong'); // 6th: 60 s
    await expectLocked(60_000);
    await attempt('wrong'); // 7th: 120 s
    await expectLocked(120_000);
    for (const ms of [240_000, 480_000]) { await attempt('wrong'); clock.advance(ms); }
    await attempt('wrong'); // 10th: capped at 15 min
    await expectLocked(15 * 60_000);
    await attempt('wrong'); // 11th: still the cap
    await expectLocked(15 * 60_000);
    expect((await attempt('password')).status).toBe(303); // success resets the counter
    for (let i = 0; i < 4; i++) await attempt('wrong');
    expect((await attempt('password')).status).toBe(303); // 4 failures: no lock
  });

  it('failures while locked do not extend the lock; unknown usernames do not lock admin', async () => {
    const { app, clock } = authApp();
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const attempt = (username: string, password: string) => agent.post('/login').type('form').send({ _csrf: csrf, username, password });
    for (let i = 0; i < 20; i++) await attempt('root', 'x');
    expect((await attempt('admin', 'password')).status).toBe(303);
    for (let i = 0; i < 5; i++) await attempt('admin', 'wrong');
    for (let i = 0; i < 5; i++) await attempt('admin', 'still-wrong'); // while locked
    clock.advance(30_000);
    expect((await attempt('admin', 'password')).status).toBe(303);
  });

  it('a parallel burst gets at most 5 real password checks before the lock holds', async () => {
    const { app, verifies } = authApp();
    const stored = (app.locals.db.prepare("SELECT password_hash h FROM users WHERE username='admin'").get() as { h: string }).h;
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password: i === 11 ? 'password' : `wrong-${i}` })));
    // Beyond the check slots (in flight + queued) an attempt is refused unchecked (503); every other one is checked.
    expect(results.every((r) => [401, 303, 503].includes(r.status))).toBe(true);
    const admitted = results.filter((r) => r.status !== 503).length;
    expect(admitted).toBeGreaterThanOrEqual(AUTH_LIMITS.checksInFlight + AUTH_LIMITS.checksQueued);
    expect(verifies.filter((h) => h === stored).length).toBeLessThanOrEqual(5);
    expect(verifies).toHaveLength(admitted);
  });

  it('persists the lock in the platform DB (a restart does not refill the budget)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-auth-'));
    tempDirs.push(dir);
    const first = authApp({ dbPath: join(dir, 'hvwa.db') });
    const agent = request.agent(first.app);
    const csrf = csrfOf((await agent.get('/login')).text);
    for (let i = 0; i < 5; i++) await agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password: 'wrong' });
    first.app.locals.db.close();
    const second = authApp({ dbPath: join(dir, 'hvwa.db') }); // same fake time T0
    expect((await signIn(request.agent(second.app))).status).toBe(401);
    second.clock.advance(30_000);
    expect((await signIn(request.agent(second.app))).status).toBe(303);
  });

  it('the README recipes work as written: the unlock applies to a running app at once; the account reset re-creates it', async () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const sql = [...readme.matchAll(/hvwa\.db'\)\.exec\('([^']+)'\)/g)].map((m) => m[1]);
    expect(sql).toEqual(['UPDATE users SET failures=0, locked_until=0', 'DELETE FROM auth_tokens; DELETE FROM users']);
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-auth-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'hvwa.db');
    const { app } = authApp({ dbPath });
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    for (let i = 0; i < 12; i++) await agent.post('/login').type('form').send({ _csrf: csrf, username: 'admin', password: 'wrong' });
    expect((await signIn(request.agent(app))).status).toBe(401); // locked (same fake time)
    const other = new (await import('node:sqlite')).DatabaseSync(dbPath); // another process's connection, as docker exec
    other.exec(sql[0]);
    expect((await signIn(request.agent(app))).status).toBe(303); // no restart, no waiting
    other.exec(sql[1]);
    other.close();
    app.locals.db.close();
    const restarted = authApp({ dbPath, initialPassword: 'Reset-Pass-123' });
    expect(restarted.app.locals.auth?.accountCreated).toBe(true);
    expect((await signIn(request.agent(restarted.app), { password: 'Reset-Pass-123' })).status).toBe(303);
  });
});

describe('CSRF on the login, logout and password forms', () => {
  // A same-host page on another port shares the cookie jar (cookies ignore ports): it can PLANT hvwa_sid and read the
  // login page served to it, so it knows the login-form token of any sid it plants. The account forms (logout,
  // password) are therefore bound to the sign-in too: HMAC(key, sid + sha256(hvwa_auth)), which it cannot know.
  it('the account forms take a token bound to hvwa_sid AND the sign-in; the login form\'s or another sign-in\'s is refused', async () => {
    const { app } = authApp();
    const a = await signedIn(app);
    const sid = sidOf(a.agent);
    const mine = await accountCsrf(a.agent);
    const loginToken = csrfOf((await withCookies(app, `hvwa_sid=${sid}`).get('/login')).text); // what a planter can read
    expect(loginToken).not.toBe(mine);
    // B signs in on the SAME (planted) hvwa_sid: same login token, its own sign-in.
    const b = await withCookies(app, `hvwa_sid=${sid}`).post('/login').type('form')
      .send({ _csrf: loginToken, username: 'admin', password: 'password' });
    expect(b.status).toBe(303);
    const bToken = authCookie(b) as string;
    const asA = withCookies(app, `hvwa_sid=${sid}; hvwa_auth=${a.token}`);
    const asB = withCookies(app, `hvwa_sid=${sid}; hvwa_auth=${bToken}`);
    const change = { current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' };
    for (const _csrf of [loginToken, csrfOf((await asB.get('/account/password')).text)]) {
      expect((await asA.post('/logout').type('form').send({ _csrf })).status).toBe(403);
      expect((await asA.post('/account/password').type('form').send({ _csrf, ...change })).status).toBe(403);
    }
    expect((await asA.get('/')).status).toBe(200); // still signed in, password unchanged
    expect((await signIn(request.agent(app))).status).toBe(303);
    // The account token is not a login token either.
    expect((await withCookies(app, `hvwa_sid=${sid}`).post('/login').type('form')
      .send({ _csrf: mine, username: 'admin', password: 'password' })).status).toBe(403);
    // A new sign-in in the same browser retires the old page's token.
    await signIn(a.agent);
    expect((await a.agent.post('/logout').type('form').send({ _csrf: mine })).status).toBe(403);
    expect((await a.agent.post('/logout').type('form').send({ _csrf: await accountCsrf(a.agent) })).status).toBe(303);
  });

  it('refuses a request whose Sec-Fetch-Site is not same-origin (cross-site, same-site, none); absent passes', async () => {
    const { app } = authApp();
    for (const site of ['cross-site', 'same-site', 'none', 'SAME-SITE']) {
      const agent = request.agent(app);
      const csrf = await csrfFor(agent); // first: an agent attaches its cookies when the request is created
      const login = await agent.post('/login').set('Sec-Fetch-Site', site).type('form')
        .send({ _csrf: csrf, username: 'admin', password: 'password' });
      expect(login.status, `login, Sec-Fetch-Site: ${site}`).toBe(403);
    }
    const { agent } = await signedIn(app);
    for (const site of ['cross-site', 'same-site', 'none']) {
      const _csrf = await accountCsrf(agent);
      expect((await agent.post('/logout').set('Sec-Fetch-Site', site).type('form').send({ _csrf })).status, site).toBe(403);
      expect((await agent.post('/account/password').set('Sec-Fetch-Site', site).type('form')
        .send({ _csrf, current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' })).status, site).toBe(403);
    }
    expect((await agent.get('/')).status).toBe(200);
    const _csrf = await accountCsrf(agent);
    const ok = await agent.post('/account/password').set('Sec-Fetch-Site', 'same-origin').type('form')
      .send({ _csrf, current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' });
    expect(ok.status).toBe(303);
    const fresh = request.agent(app);
    const freshCsrf = await csrfFor(fresh);
    expect((await fresh.post('/login').set('Sec-Fetch-Site', 'same-origin').type('form')
      .send({ _csrf: freshCsrf, username: 'admin', password: 'New-Pass-123' })).status).toBe(303);
  });

  it('the Origin must match the scheme too: https://<this host> is another origin (X-Forwarded-Proto changes nothing)', async () => {
    const { app } = authApp();
    for (const extra of [{}, { 'X-Forwarded-Proto': 'https' }]) {
      const agent = request.agent(app);
      const csrf = await csrfFor(agent);
      const res = await agent.post('/login').set('Host', '127.0.0.1:1337').set('Origin', 'https://127.0.0.1:1337').set(extra)
        .type('form').send({ _csrf: csrf, username: 'admin', password: 'password' });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
    const agent = request.agent(app);
    const csrf = await csrfFor(agent);
    const ok = await agent.post('/login').set('Host', '127.0.0.1:1337').set('Origin', 'http://127.0.0.1:1337')
      .type('form').send({ _csrf: csrf, username: 'admin', password: 'password' });
    expect(ok.status).toBe(303);
  });

  it('refuses a missing, wrong or another session\'s token with 403, before any password check', async () => {
    const { app, verifies } = authApp();
    const mine = request.agent(app);
    await mine.get('/login');
    const theirs = csrfOf((await request.agent(app).get('/login')).text);
    for (const _csrf of [undefined, '', 'x', theirs, 'A'.repeat(43)]) {
      const res = await mine.post('/login').type('form').send({ ...(_csrf === undefined ? {} : { _csrf }), username: 'admin', password: 'password' });
      expect(res.status, String(_csrf)).toBe(403);
      expect(authCookie(res)).toBeUndefined();
      expect(res.text).toContain('data-testid="csrf-error"');
    }
    expect(verifies).toHaveLength(0);
    // A browser without hvwa_sid (a cross-site post: SameSite=Lax keeps it home) gets a new session: no token can match.
    const cold = await request(app).post('/login').type('form').send({ _csrf: theirs, username: 'admin', password: 'password' });
    expect(cold.status).toBe(403);
  });

  it('refuses a cross-origin Origin even with a valid token; allows a same-origin or absent Origin', async () => {
    const { app } = authApp();
    // [Host the browser talks to, Origin it sends]. A same-host page on ANOTHER PORT is another origin (and the
    // same site: cookies ignore ports, so it is exactly the attacker that can plant hvwa_sid).
    for (const [host, origin] of [
      [undefined, 'http://evil.example'], [undefined, 'null'], [undefined, 'http://127.0.0.1.evil.example'],
      [undefined, 'https://evil.example:1337'], [undefined, 'file://'],
      ['127.0.0.1:1337', 'http://127.0.0.1:1338'], ['127.0.0.1:1337', 'http://127.0.0.1:13370'], ['127.0.0.1:1337', 'http://127.0.0.1'],
      ['localhost:1337', 'http://localhost:1338'], ['localhost:1337', 'http://localhost'], ['localhost', 'http://localhost:8080'],
      ['127.0.0.1:1337', 'http://localhost:1337'],
    ] as const) {
      const agent = request.agent(app);
      const csrf = csrfOf((await agent.get('/login')).text);
      const post = agent.post('/login');
      if (host) post.set('Host', host);
      const res = await post.set('Origin', origin).type('form').send({ _csrf: csrf, username: 'admin', password: 'password' });
      expect(res.status, `Host ${host ?? '(default)'} Origin ${origin}`).toBe(403);
    }
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const ok = await agent.post('/login').set('Host', 'localhost:1337').set('Origin', 'http://localhost:1337')
      .type('form').send({ _csrf: csrf, username: 'admin', password: 'password' });
    expect(ok.status).toBe(303);
    expect((await signIn(request.agent(app))).status).toBe(303); // no Origin at all (older clients, curl)
  });

  it('logout and the password form need the token too', async () => {
    const { app } = authApp();
    const { agent, token } = await signedIn(app);
    expect((await agent.post('/logout').type('form').send({})).status).toBe(403);
    expect((await agent.post('/logout').type('form').send({ _csrf: 'x' })).status).toBe(403);
    const csrf = csrfOf((await agent.get('/account/password')).text);
    expect((await agent.post('/logout').set('Origin', 'http://evil.example').type('form').send({ _csrf: csrf })).status).toBe(403);
    expect((await withCookies(app, `hvwa_auth=${token}`).get('/')).status).toBe(200); // still signed in
    const change = { current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' };
    expect((await agent.post('/account/password').type('form').send(change)).status).toBe(403);
    expect((await agent.post('/account/password').set('Origin', 'http://evil.example').type('form').send({ _csrf: csrf, ...change })).status).toBe(403);
    expect((await signIn(request.agent(app))).status).toBe(303); // the password did not change
  });
});

describe('the next parameter (no open redirect)', () => {
  const evil = ['//evil.example', '/\\evil.example', '\\\\evil.example', 'https://evil.example', 'http:evil.example',
    '/%2F%2Fevil.example', '%2F%2Fevil.example', '/%5Cevil.example', '/%252F%252Fevil.example', 'javascript:alert(1)',
    '/\r\nSet-Cookie: x=1', '/%0d%0aSet-Cookie:x=1', '/\tevil', ' //evil.example', '/login',
    // dot segments that normalise to //evil.example (only the check on the NORMALISED path stops these)
    '/a/..//evil.example', '/a/%2e%2e//evil.example', '/.//evil.example', '/%2e//evil.example'];

  it.each(evil)('POST /login with next=%j redirects to /', async (next) => {
    const { app } = authApp();
    const res = await signIn(request.agent(app), { next });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
  });

  it('GET /login?next=<evil> renders next as /, and so does a signed-in GET /login', async () => {
    const { app } = authApp();
    for (const next of evil) {
      const page = await request(app).get(`/login?next=${encodeURIComponent(next)}`);
      expect(page.text, next).toContain('name="next" value="/"');
    }
    const { agent } = await signedIn(app);
    for (const next of evil) {
      const res = await agent.get(`/login?next=${encodeURIComponent(next)}`);
      expect(res.headers.location, next).toBe('/');
    }
  });

  it('a raw encoded query (as an attacker would link it) is decoded once and still refused', async () => {
    const { app } = authApp();
    for (const raw of ['%2F%2Fevil.example', '%2F%5Cevil.example', 'https%3A%2F%2Fevil.example', '%2F%250d%250aX:1', '//evil.example']) {
      const { agent } = await signedIn(app);
      const res = await agent.get(`/login?next=${raw}`);
      expect(res.headers.location, raw).toBe('/');
    }
  });

  it('a local next is kept across a failed attempt', async () => {
    const { app } = authApp();
    const agent = request.agent(app);
    const failed = await signIn(agent, { password: 'nope', next: '/c/ZA-01' });
    expect(failed.text).toContain('name="next" value="/c/ZA-01"');
    expect((await signIn(agent, { next: '/c/ZA-01' })).headers.location).toBe('/c/ZA-01');
  });
});

describe('signing out', () => {
  it('POST /logout revokes the token server-side, clears the cookie and goes to /login', async () => {
    const { app } = authApp();
    const { agent, token } = await signedIn(app);
    const csrf = csrfOf((await agent.get('/')).text); // the layout's logout form carries it
    const res = await agent.post('/logout').type('form').send({ _csrf: csrf });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login');
    expect(setCookieHeader(res, 'hvwa_auth')).toMatch(/^hvwa_auth=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$/);
    expect((await agent.get('/')).status).toBe(303);
    expect((await withCookies(app, `hvwa_auth=${token}`).get('/')).status).toBe(303); // a replayed copy is dead too
  });

  it('GET /logout is not a way out (no state change on GET)', async () => {
    const { app } = authApp();
    const { agent } = await signedIn(app);
    expect((await agent.get('/logout')).status).toBe(404);
    expect((await agent.get('/')).status).toBe(200);
  });
});

describe('token lifetime (fake clock)', () => {
  it('expires after the idle timeout; activity keeps it alive', async () => {
    const { app, clock } = authApp();
    const { token } = await signedIn(app);
    const get = () => withCookies(app, `hvwa_auth=${token}`).get('/scoreboard');
    clock.advance(AUTH_LIMITS.idleMs - 1);
    expect((await get()).status).toBe(200); // touched now
    clock.advance(AUTH_LIMITS.idleMs - 1);
    expect((await get()).status).toBe(200);
    clock.advance(AUTH_LIMITS.idleMs);
    const res = await get();
    expect(res.status).toBe(303);
    expect(setCookieHeader(res, 'hvwa_auth')).toMatch(/^hvwa_auth=;/);
  });

  it('expires after the absolute lifetime even when active', async () => {
    const { app, clock } = authApp();
    const { token } = await signedIn(app);
    const get = () => withCookies(app, `hvwa_auth=${token}`).get('/');
    const step = Math.floor(AUTH_LIMITS.idleMs / 2);
    let elapsed = 0;
    while (elapsed + step < AUTH_LIMITS.tokenTtlMs) {
      clock.advance(step);
      elapsed += step;
      expect((await get()).status, `${elapsed} ms`).toBe(200);
    }
    clock.advance(AUTH_LIMITS.tokenTtlMs - elapsed);
    expect((await get()).status).toBe(303);
  });

  it('keeps a bounded number of tokens per account (the oldest go first)', async () => {
    const { app } = authApp();
    const first = await signedIn(app);
    for (let i = 0; i < AUTH_LIMITS.maxTokens; i++) await signedIn(app);
    const rows = (app.locals.db.prepare('SELECT COUNT(*) n FROM auth_tokens').get() as { n: number }).n;
    expect(rows).toBe(AUTH_LIMITS.maxTokens);
    expect((await withCookies(app, `hvwa_auth=${first.token}`).get('/')).status).toBe(303);
  });
});

describe('changing the password', () => {
  const form = async (agent: Agent, fields: Record<string, string>) => {
    const csrf = csrfOf((await agent.get('/account/password')).text);
    return agent.post('/account/password').type('form').send({ _csrf: csrf, ...fields });
  };

  it('needs the current password, >= 8 characters, a match, and a new value', async () => {
    const { app } = authApp();
    const { agent } = await signedIn(app);
    const page = await agent.get('/account/password');
    expect(page.status).toBe(200);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.text).toContain('autocomplete="new-password"');
    for (const [fields, error] of [
      [{ current: 'wrong-pass', password: 'New-Pass-123', confirm: 'New-Pass-123' }, 'current'],
      [{ current: 'password', password: 'short7!', confirm: 'short7!' }, 'too_short'],
      [{ current: 'password', password: 'x'.repeat(1025), confirm: 'x'.repeat(1025) }, 'too_long'],
      [{ current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-124' }, 'mismatch'],
      [{ current: 'password', password: 'New\u0000Pass-123', confirm: 'New\u0000Pass-123' }, 'control'],
      [{ current: 'password', password: 'New-Pass\t123', confirm: 'New-Pass\t123' }, 'control'],
      [{ current: 'password', password: 'password', confirm: 'password' }, 'same'],
      [{ current: 'password', password: '', confirm: '' }, 'too_short'],
    ] as const) {
      const res = await form(agent, fields);
      expect(res.status, error).toBe(400);
      expect(res.text, error).toContain(`data-error="${error}"`);
      for (const v of [fields.current, fields.password, fields.confirm]) if (v) expect(res.text).not.toContain(`value="${v.slice(0, 40)}`);
    }
    expect((await signIn(request.agent(app))).status).toBe(303); // unchanged
  });

  it('changes it, invalidates EVERY token (other browsers too), and keeps only this browser signed in', async () => {
    const { app } = authApp();
    const me = await signedIn(app);
    const other = await signedIn(app);
    const res = await form(me.agent, { current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/account/password?changed=1');
    const fresh = authCookie(res) as string;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(me.token);
    expect((await withCookies(app, `hvwa_auth=${me.token}`).get('/')).status).toBe(303);
    expect((await withCookies(app, `hvwa_auth=${other.token}`).get('/')).status).toBe(303);
    expect((await other.agent.get('/')).status).toBe(303);
    const done = await me.agent.get('/account/password?changed=1');
    expect(done.status).toBe(200);
    expect(done.text).toContain('data-testid="password-changed"');
    expect((await signIn(request.agent(app))).status).toBe(401); // the old password is gone
    expect((await signIn(request.agent(app), { password: 'New-Pass-123' })).status).toBe(303);
  });

  it('refuses the default password as the new one', async () => {
    const { app } = authApp({ initialPassword: 'Start-Pass-123' });
    const { agent } = await signedIn(app, 'Start-Pass-123');
    const res = await form(agent, { current: 'Start-Pass-123', password: 'password', confirm: 'password' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('data-error="default"');
  });

  it('wrong current passwords count toward the same backoff as sign-ins', async () => {
    const { app, clock } = authApp();
    const { agent } = await signedIn(app);
    for (let i = 0; i < 5; i++) await form(agent, { current: `wrong-${i}`, password: 'New-Pass-123', confirm: 'New-Pass-123' });
    const locked = await form(agent, { current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' });
    expect(locked.status).toBe(400);
    expect(locked.text).toContain('data-error="current"');
    expect((await signIn(request.agent(app))).status).toBe(401);
    clock.advance(30_000);
    expect((await form(agent, { current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' })).status).toBe(303);
  });
});

describe('the default-password banner', () => {
  it('shows on every page while admin / password is in use, and goes away after a change', async () => {
    const { app } = authApp();
    const { agent } = await signedIn(app);
    for (const path of ['/', '/scoreboard', '/c/ZA-01', '/account/password']) {
      const page = await agent.get(path);
      expect(page.text, path).toContain('data-testid="default-password-banner"');
      expect(page.text, path).toContain("You&#39;re using the default password — change it");
      expect(page.text, path).toContain('href="/account/password"');
    }
    expect((await agent.get('/?lang=id')).text).toContain('Anda masih memakai kata sandi bawaan');
    const csrf = csrfOf((await agent.get('/account/password')).text);
    const changed = await agent.post('/account/password').type('form')
      .send({ _csrf: csrf, current: 'password', password: 'New-Pass-123', confirm: 'New-Pass-123' });
    expect(changed.status).toBe(303);
    for (const path of ['/', '/scoreboard', '/account/password']) {
      expect((await agent.get(path)).text, path).not.toContain('data-testid="default-password-banner"');
    }
  });

  it('never shows when HVWA_ADMIN_PASSWORD set the first password; admin / password then fails', async () => {
    const { app } = authApp({ initialPassword: 'Env-Pass-123' });
    expect((await signIn(request.agent(app))).status).toBe(401);
    const { agent } = await signedIn(app, 'Env-Pass-123');
    expect((await agent.get('/')).text).not.toContain('data-testid="default-password-banner"');
    expect(app.locals.auth?.usesDefaultPassword()).toBe(false);
  });

  it('the initial password applies only when the account does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-auth-'));
    tempDirs.push(dir);
    const first = authApp({ dbPath: join(dir, 'hvwa.db') });
    expect(first.app.locals.auth?.usesDefaultPassword()).toBe(true);
    first.app.locals.db.close();
    const second = authApp({ dbPath: join(dir, 'hvwa.db'), initialPassword: 'Later-Pass-123' });
    expect((await signIn(request.agent(second.app), { password: 'Later-Pass-123' })).status).toBe(401);
    expect((await signIn(request.agent(second.app))).status).toBe(303);
  });
});

describe('hvwa_sid and lab progress survive signing in and out', () => {
  it('never re-issues hvwa_sid; solves, hints and perSession lab state stay with the session', async () => {
    const { app } = authApp();
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const sid = setCookieValue(page, 'hvwa_sid') as string;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    const login = await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password: 'password' });
    expect(setCookieHeader(login, 'hvwa_sid')).toBeUndefined();
    expect((await agent.post('/api/submit').send({ challengeId: 'ZA-01', submission: issueFlag('ZA-01', sid, 'acolyte') })).body)
      .toMatchObject({ solved: true });
    expect((await agent.post('/api/hint').send({ challengeId: 'ZA-01', tier: 1 })).body).toMatchObject({ unlocked: true });
    expect((await agent.post('/d/auth-test/counter/hit?level=acolyte')).body).toEqual({ n: 1 });
    const logout = await agent.post('/logout').type('form').send({ _csrf: await accountCsrf(agent) });
    expect(setCookieHeader(logout, 'hvwa_sid')).toBeUndefined();
    const again = await signIn(agent);
    expect(setCookieHeader(again, 'hvwa_sid')).toBeUndefined();
    const board = (await agent.get('/scoreboard')).text;
    expect(board).toContain('data-testid="solved">1<');
    expect(board).toContain('data-testid="score">90<');
    expect((await agent.post('/d/auth-test/counter/hit?level=acolyte')).body).toEqual({ n: 2 });
    expect(sidOf(agent)).toBe(sid);
  });
});

describe('storage: only hashes', () => {
  it('a tampered account row asking for N=2^30 is a plain failed sign-in: no crash, no terabyte, the app keeps answering', async () => {
    const { app } = authApp();
    const db = app.locals.db;
    const stored = (db.prepare("SELECT password_hash h FROM users WHERE username='admin'").get() as { h: string }).h;
    const tampered = stored.replace(/^scrypt\$\d+\$/, `scrypt$${2 ** 30}$`);
    expect(tampered).not.toBe(stored);
    db.prepare("UPDATE users SET password_hash = ? WHERE username='admin'").run(tampered);
    const t0 = performance.now();
    const res = await signIn(request.agent(app));
    expect(res.status).toBe(401);
    expect(res.text).toContain('data-testid="login-error"');
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
  });

  it('the DB never holds a password or a token in plaintext (rows, file and WAL)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hvwa-auth-'));
    tempDirs.push(dir);
    const { app } = authApp({ dbPath: join(dir, 'hvwa.db'), initialPassword: 'Initial-Pass-123' });
    const me = await signedIn(app, 'Initial-Pass-123');
    const csrf = csrfOf((await me.agent.get('/account/password')).text);
    const changed = await me.agent.post('/account/password').type('form')
      .send({ _csrf: csrf, current: 'Initial-Pass-123', password: 'Changed-Pass-456', confirm: 'Changed-Pass-456' });
    const token = authCookie(changed) as string;
    await signIn(request.agent(app), { password: 'Wrong-Guess-789' });
    const db = app.locals.db;
    const account = db.prepare('SELECT * FROM users').all();
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({ username: 'admin', is_default: 0 });
    expect(String(account[0].password_hash)).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    const tokens = db.prepare('SELECT token_hash FROM auth_tokens').all().map((r) => r.token_hash);
    expect(tokens).toEqual([createHash('sha256').update(token).digest('hex')]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const dump = JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM "${t}"`).all().map((r) => Object.values(r))));
    const files = () => readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n');
    for (const secret of ['Initial-Pass-123', 'Changed-Pass-456', 'Wrong-Guess-789', token]) {
      expect(dump, secret).not.toContain(secret);
      expect(files(), secret).not.toContain(secret);
    }
    db.close();
    for (const secret of ['Initial-Pass-123', 'Changed-Pass-456', 'Wrong-Guess-789', token]) expect(files(), secret).not.toContain(secret);
  });
});

describe('auth OFF (the default outside production) leaves the portal exactly as before', () => {
  it('createApp() with HVWA_AUTH=off (tests/support/setup.ts): no gate, no auth routes, no cookie, no markup', async () => {
    expect(process.env.HVWA_AUTH).toBe('off');
    const app = createApp({ flagSecret: TEST_SECRET });
    apps.push(app);
    expect(app.locals.auth).toBeUndefined();
    const index = await request(app).get('/');
    expect(index.status).toBe(200);
    expect(setCookieHeader(index, 'hvwa_auth')).toBeUndefined();
    for (const marker of ['account-nav', 'default-password-banner', '/logout', '_csrf', 'hvwa_auth']) expect(index.text).not.toContain(marker);
    expect((await request(app).get('/login')).status).toBe(404);
    expect((await request(app).post('/login').type('form').send({ username: 'admin', password: 'password' })).status).toBe(404);
    expect((await request(app).post('/logout')).status).toBe(404);
    expect((await request(app).get('/account/password')).status).toBe(404);
    expect((await request(app).post('/api/submit').send({ challengeId: 'ZA-01', submission: 'x' })).status).toBe(200);
    expect(app.locals.db.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 0 }); // no account is created
  });

  it('the createApp option overrides the environment both ways', async () => {
    vi.stubEnv('HVWA_AUTH', 'on');
    try {
      const envOn = createApp({ flagSecret: TEST_SECRET });
      apps.push(envOn);
      expect((await request(envOn).get('/')).status).toBe(303);
      const forcedOff = createApp({ flagSecret: TEST_SECRET, auth: false });
      apps.push(forcedOff);
      expect((await request(forcedOff).get('/')).status).toBe(200);
      vi.stubEnv('HVWA_AUTH', 'off');
      const forcedOn = createApp({ flagSecret: TEST_SECRET, auth: true });
      apps.push(forcedOn);
      expect((await request(forcedOn).get('/')).status).toBe(303);
      vi.stubEnv('HVWA_AUTH', '');
      vi.stubEnv('NODE_ENV', 'production'); // the Docker image: unset HVWA_AUTH means ON
      const prod = createApp({ flagSecret: TEST_SECRET });
      apps.push(prod);
      expect((await request(prod).get('/')).status).toBe(303);
      vi.stubEnv('NODE_ENV', 'development');
      const dev = createApp({ flagSecret: TEST_SECRET });
      apps.push(dev);
      expect((await request(dev).get('/')).status).toBe(200);
      vi.stubEnv('HVWA_AUTH', 'yes');
      expect(() => createApp({ flagSecret: TEST_SECRET })).toThrow(/^HVWA_AUTH: /);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env.HVWA_AUTH).toBe('off');
  });
});
