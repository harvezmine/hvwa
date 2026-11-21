// Open self-registration (src/auth/register.ts, spec range §4 and §16): the rules, the per-IP limit (5 accounts per
// hour), the env switch (HVWA_REGISTRATION_OPEN=0 → the `open: false` option), and the same CSRF / Origin /
// Sec-Fetch-Site guards as the login form. Mounted only when the `registration` option is given (portal mode).
// Compact POC (plan amendment): no event code and no admin open/closed switch.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { windowLimiter } from '../src/auth/rate-limit.js';
import { clientIp } from '../src/auth/client-ip.js';
import { authHarness, csrfOf, FAST_HASHER, HARNESS_ADMIN_PASSWORD } from './helpers.js';

const PW = 'Player-Pass-1';
const T0 = Date.UTC(2026, 10, 20, 10);
type Agent = ReturnType<typeof request.agent>;

function regApp(registration: { open?: boolean; perIp?: number } = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const h = authHarness({ passwordMinLength: 10, now: clock.now, registration: { now: clock.now, ...registration } });
  return { ...h, clock };
}
async function register(agent: Agent, fields: Record<string, string>) {
  const page = await agent.get('/register');
  return agent.post('/register').type('form').send({ _csrf: csrfOf(page.text), ...fields });
}

describe('GET /register', () => {
  it('is open before the gate, never cached or framed, with username/password/confirm and a CSRF token', async () => {
    const { app } = regApp();
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers.vary)).toMatch(/Cookie/i);
    for (const name of ['username', 'password', 'confirm', '_csrf']) expect(res.text).toContain(`name="${name}"`);
    expect(res.text).not.toContain('name="code"'); // no event code in the POC
    expect(res.text).toContain('minlength="10"');
  });

  it('a signed-in browser is sent home', async () => {
    const { app } = regApp();
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password: HARNESS_ADMIN_PASSWORD });
    const again = await agent.get('/register');
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe('/');
  });

  it('is not mounted without the registration option (standalone)', async () => {
    const { app } = authHarness({ passwordMinLength: 10 });
    expect((await request(app).get('/register')).status).toBe(303); // behind the gate like any unknown page
    expect((await request(app).get('/login')).text).not.toContain('data-testid="register-link"');
  });
});

describe('POST /register', () => {
  it('creates a player, sends the browser to /login?registered=1, which says so; the account signs in', async () => {
    const { app, auth } = regApp();
    const agent = request.agent(app);
    const res = await register(agent, { username: 'Alice', password: PW, confirm: PW });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login?registered=1');
    expect(auth.service.listUsers().map((u) => [u.username, u.role])).toEqual([['admin', 'admin'], ['alice', 'player']]);
    const login = await agent.get('/login?registered=1');
    expect(login.text).toContain('data-testid="registered"');
    const signed = await agent.post('/login').type('form').send({ _csrf: csrfOf(login.text), username: 'alice', password: PW });
    expect(signed.status).toBe(303);
  });

  it('needs the login-form token, a same-origin post and no foreign Origin (403, nothing created)', async () => {
    const { app, auth } = regApp();
    const agent = request.agent(app);
    const token = csrfOf((await agent.get('/register')).text);
    const ok = { username: 'bob', password: PW, confirm: PW };
    expect((await agent.post('/register').type('form').send(ok)).status).toBe(403);
    expect((await agent.post('/register').set('Origin', 'http://evil.example').type('form').send({ _csrf: token, ...ok })).status).toBe(403);
    expect((await agent.post('/register').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: token, ...ok })).status).toBe(403);
    expect(auth.service.listUsers()).toHaveLength(1);
  });

  it.each([
    [{ username: 'ab', password: PW, confirm: PW }, 'username'],
    [{ username: 'admin', password: PW, confirm: PW }, 'taken'],
    [{ username: 'carol', password: 'Short-pw1', confirm: 'Short-pw1' }, 'too_short'],
    [{ username: 'carol', password: PW, confirm: `${PW}!` }, 'mismatch'],
  ])('a rule failure re-renders 400 with data-error, keeps the username (escaped), never a password: %j', async (fields, error) => {
    const { app } = regApp();
    const res = await register(request.agent(app), fields);
    expect(res.status).toBe(400);
    expect(res.text).toContain(`data-error="${error}"`);
    expect(res.text).not.toContain(PW);
  });

  it('escapes the typed username it shows again', async () => {
    const { app } = regApp();
    const res = await register(request.agent(app), { username: '"><script>x</script>', password: PW, confirm: PW });
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(res.text).not.toContain('<script>x');
  });

  it('a `code` field is ignored: there is no event code', async () => {
    const { app, auth } = regApp();
    expect((await register(request.agent(app), { username: 'dave', password: PW, confirm: PW, code: 'ANYTHING' })).status).toBe(303);
    expect(auth.service.listUsers().map((u) => u.username)).toEqual(['admin', 'dave']);
  });

  it('closed (HVWA_REGISTRATION_OPEN=0): GET and POST answer 403 "closed", nothing is created, the login page hides the link', async () => {
    expect((await request(regApp().app).get('/login')).text).toContain('data-testid="register-link"');
    const { app, auth } = regApp({ open: false });
    const agent = request.agent(app);
    const page = await agent.get('/register');
    expect(page.status).toBe(403);
    expect(page.text).toContain('data-testid="registration-closed"');
    expect(page.text).not.toContain('name="username"');
    const login = await agent.get('/login');
    expect(login.text).not.toContain('data-testid="register-link"');
    // The registration form's token is the login form's (bound to hvwa_sid): a valid one still meets a closed door.
    const post = await agent.post('/register').type('form').send({ _csrf: csrfOf(login.text), username: 'gus', password: PW, confirm: PW });
    expect(post.status).toBe(403);
    expect(post.text).toContain('data-testid="registration-closed"');
    expect(auth.service.listUsers()).toHaveLength(1);
  });

  it('5 accounts per IP per hour: the 6th is 429 and creates nothing; rule failures never count; an hour later it is open', async () => {
    const { app, clock, auth } = regApp({ perIp: 5 });
    const agent = request.agent(app);
    expect((await register(agent, { username: 'ab', password: PW, confirm: PW })).status).toBe(400);
    for (let i = 1; i <= 5; i++) expect((await register(agent, { username: `user_${i}`, password: PW, confirm: PW })).status).toBe(303);
    const sixth = await register(agent, { username: 'user_6', password: PW, confirm: PW });
    expect(sixth.status).toBe(429);
    expect(sixth.headers['retry-after']).toBe('3600');
    expect(sixth.text).toContain('data-testid="registration-limited"');
    expect(auth.service.listUsers()).toHaveLength(6);
    clock.advance(60 * 60_000);
    expect((await register(agent, { username: 'user_6', password: PW, confirm: PW })).status).toBe(303);
  });

  it('the default limit is 5 per IP per hour', async () => {
    const { app } = regApp();
    const agent = request.agent(app);
    for (let i = 1; i <= 5; i++) expect((await register(agent, { username: `dflt_${i}`, password: PW, confirm: PW })).status).toBe(303);
    expect((await register(agent, { username: 'dflt_6', password: PW, confirm: PW })).status).toBe(429);
  });
});

describe('windowLimiter', () => {
  it('allows max hits per key per window, keys are independent, and at most maxKeys keys are tracked', () => {
    let t = 0;
    const l = windowLimiter({ max: 2, windowMs: 1000, now: () => t, maxKeys: 2 });
    expect([l.allow('a'), l.allow('a'), l.allow('a')]).toEqual([true, true, false]);
    expect(l.allow('b')).toBe(true);
    t = 1000;
    expect(l.allow('a')).toBe(true);
    expect(l.count('a')).toBe(1);
    l.allow('c');
    expect(l.count('b')).toBe(0); // evicted: the least recently used key goes first
    expect(() => windowLimiter({ max: 0, windowMs: 1 })).toThrow();
  });
});

describe('the client IP (spec §12: CF-Connecting-IP behind the tunnel, else the socket address)', () => {
  it('clientIp takes a valid CF-Connecting-IP, else the socket address', () => {
    const req = (h?: string) => ({ get: (n: string) => (n.toLowerCase() === 'cf-connecting-ip' ? h : undefined), socket: { remoteAddress: '10.0.0.9' } });
    expect(clientIp(req('203.0.113.7') as never)).toBe('203.0.113.7');
    expect(clientIp(req(' 2001:db8::1 ') as never)).toBe('2001:db8::1');
    for (const bad of [undefined, '', 'evil', '203.0.113.7, 10.0.0.1']) expect(clientIp(req(bad) as never)).toBe('10.0.0.9');
  });

  it('the registration limit keys on it: one IP is full, another is not', async () => {
    const { app } = regApp({ perIp: 2 });
    const agent = request.agent(app);
    const from = async (ip: string, username: string) => {
      const page = await agent.get('/register');
      return agent.post('/register').set('CF-Connecting-IP', ip).type('form').send({ _csrf: csrfOf(page.text), username, password: PW, confirm: PW });
    };
    expect((await from('203.0.113.7', 'ip_a1')).status).toBe(303);
    expect((await from('203.0.113.7', 'ip_a2')).status).toBe(303);
    expect((await from('203.0.113.7', 'ip_a3')).status).toBe(429);
    expect((await from('198.51.100.4', 'ip_b1')).status).toBe(303);
  });

  it('signInPerIp: past the budget of failed sign-ins even the right password is refused unchecked (429); another IP is not', async () => {
    let verifies = 0;
    const hasher = { ...FAST_HASHER, verify: async (p: string, stored: string) => { verifies += 1; return FAST_HASHER.verify(p, stored); } };
    const { app } = authHarness({ hasher, signInPerIp: { max: 3, windowMs: 60_000 } });
    const agent = request.agent(app);
    const attempt = async (ip: string, password: string) => {
      const page = await agent.get('/login');
      return agent.post('/login').set('CF-Connecting-IP', ip).type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password });
    };
    for (let i = 0; i < 3; i++) expect((await attempt('203.0.113.7', 'wrong-password')).status).toBe(401);
    const checked = verifies;
    const limited = await attempt('203.0.113.7', HARNESS_ADMIN_PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.text).toContain('Too many failed sign-ins');
    expect(verifies).toBe(checked);
    expect((await attempt('198.51.100.4', HARNESS_ADMIN_PASSWORD)).status).toBe(303);
  });

  it('without signInPerIp (standalone) failed sign-ins are only the per-account backoff\'s business', async () => {
    const { app } = authHarness({});
    const agent = request.agent(app);
    for (let i = 0; i < 4; i++) {
      const page = await agent.get('/login');
      expect((await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password: 'wrong-password' })).status).toBe(401);
    }
    const page = await agent.get('/login');
    expect((await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password: HARNESS_ADMIN_PASSWORD })).status).toBe(303);
  });
});
