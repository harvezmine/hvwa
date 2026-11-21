// The platform form guards other routers reuse (src/auth/forms.ts; PlatformAuth.formOk, csrfFor, refuse), requireAdmin,
// the Secure attribute of portal mode and the password page's minimum. Same rules as the login's own forms.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { requireAdmin } from '../src/auth/index.js';
import { authHarness, csrfOf, HARNESS_ADMIN_PASSWORD, setCookieHeader } from './helpers.js';
import { Router } from 'express';

type Agent = ReturnType<typeof request.agent>;
async function signIn(agent: Agent, username: string, password: string) {
  const page = await agent.get('/login');
  return agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username, password });
}
function harness(opts: Parameters<typeof authHarness>[0] = {}) {
  return authHarness(opts, (app, auth) => {
    app.get('/probe-token', (req, res) => { res.json({ csrf: auth.csrfFor(req) }); });
    app.post('/probe', async (req, res) => {
      if (!auth.formOk(req)) { await auth.refuse(req, res, '/'); return; }
      res.json({ ok: true, who: res.locals.platformAuth });
    });
    const admin = Router();
    admin.use(requireAdmin);
    admin.get('/admin/probe', (_req, res) => { res.send('admin only'); });
    app.use(admin);
  });
}

describe('PlatformAuth.formOk / csrfFor / refuse (account forms of other routers)', () => {
  it('accepts this browser\'s account token; the locals carry user id, name and role', async () => {
    const { app } = harness();
    const agent = request.agent(app);
    expect((await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD)).status).toBe(303);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    const res = await agent.post('/probe').type('form').send({ _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.body.who).toMatchObject({ signedIn: true, userId: 1, user: 'admin', role: 'admin', defaultPassword: false });
  });

  it('refuses a missing or login-form token, a foreign Origin and a cross-site fetch with the 403 page', async () => {
    const { app } = harness();
    const agent = request.agent(app);
    const loginToken = csrfOf((await agent.get('/login')).text);
    await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    for (const [label, send] of [
      ['no token', () => agent.post('/probe').type('form').send({})],
      ['login token', () => agent.post('/probe').type('form').send({ _csrf: loginToken })],
      ['foreign origin', () => agent.post('/probe').set('Origin', 'http://evil.example').type('form').send({ _csrf: csrf })],
      ['cross-site', () => agent.post('/probe').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: csrf })],
      ['same-site', () => agent.post('/probe').set('Sec-Fetch-Site', 'same-site').type('form').send({ _csrf: csrf })],
    ] as const) {
      const res = await send();
      expect(res.status, label).toBe(403);
      expect(res.text, label).toContain('data-testid="csrf-error"');
    }
  });
});

describe('requireAdmin', () => {
  it('lets an admin through; a player gets the ordinary 404', async () => {
    const { app, auth } = harness();
    await auth.service.register('player_one', 'Player-Pass-1', 'Player-Pass-1');
    const admin = request.agent(app);
    await signIn(admin, 'admin', HARNESS_ADMIN_PASSWORD);
    expect((await admin.get('/admin/probe')).text).toBe('admin only');
    const player = request.agent(app);
    expect((await signIn(player, 'player_one', 'Player-Pass-1')).status).toBe(303);
    expect((await player.get('/admin/probe')).status).toBe(404);
  });
});

describe('publicScheme (portal mode: the browser speaks https to Cloudflare, the portal sees http)', () => {
  it('the Origin must carry the public scheme, not the request\'s', async () => {
    const { app } = harness({ publicScheme: 'https' });
    const agent = request.agent(app);
    await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    const post = (origin: string) => agent.post('/probe').set('Host', 'portal.test').set('Origin', origin).type('form').send({ _csrf: csrf });
    expect((await post('https://portal.test')).status).toBe(200);
    expect((await post('http://portal.test')).status).toBe(403);
  });
});

describe('secureCookies (portal mode, behind HTTPS)', () => {
  it('adds Secure to hvwa_auth; off by default (standalone serves plain http on loopback)', async () => {
    const secure = await signIn(request.agent(harness({ secureCookies: true }).app), 'admin', HARNESS_ADMIN_PASSWORD);
    expect(setCookieHeader(secure, 'hvwa_auth')).toMatch(/; Secure(;|$)/);
    const plain = await signIn(request.agent(harness().app), 'admin', HARNESS_ADMIN_PASSWORD);
    expect(setCookieHeader(plain, 'hvwa_auth')).not.toMatch(/Secure/);
  });
});

describe('the password page follows passwordMinLength', () => {
  it('minlength and the help text say 10 in portal mode, 8 by default', async () => {
    for (const [min, opts] of [[10, { passwordMinLength: 10 }], [8, {}]] as const) {
      const agent = request.agent(harness(opts).app);
      await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
      const page = (await agent.get('/account/password')).text;
      expect(page).toContain(`minlength="${min}"`);
      expect(page).toContain(`At least ${min} characters`);
    }
  });
});
