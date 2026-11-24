// HVWA_MODE=portal (createApp({ mode: 'portal', range })): the range portal mounts no labs and no /api, puts every page
// behind the login, lists the range labs from the registry (difficulty, levels, points, hints), ranks players, shows the
// range navigation, and fails closed on instance hosts and the internal host until the gate exists.
// Compact POC (plan amendment): no admin pages, so no Admin link; registration follows `registrationOpen`.
import { describe, it, expect, onTestFinished } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/districts/index.js'; // the standalone challenges are registered: portal mode must serve none of them
import { createApp, type HvwaApp } from '../src/app.js';
import { recordRangeSolve } from '../src/range/progress.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { base32, INSTANCE_ID_RE, newInstanceId } from '../src/range/ids.js';
import { instanceHost, instanceIdOfHost, instanceOrigin, portalOrigin } from '../src/range/hosts.js';
import { csrfOf, FAST_HASHER, serve, setCookieHeader, setCookieValue, TEST_SECRET } from './helpers.js';
import { parseRegistry, TRACKS } from '../src/lab-registry.js';
import { ADMIN_PASSWORD, DOMAIN, FORWARD_SECRET, labEntry, player, portalApp, RANGE_KEY, signInAdmin, testRegistry, T0 } from './support/range.js';
import { fakeWarden } from './support/fake-warden.js';

const rangeOptions = () => ({
  domain: DOMAIN, portalHost: DOMAIN, internalHost: 'portal', registry: testRegistry(), limits: DEFAULT_LIMITS,
  warden: fakeWarden({ autoReady: true }), rangeKey: RANGE_KEY, forwardAuthSecret: FORWARD_SECRET,
});

/** GET with an absolute-form request target (`GET http://name/ HTTP/1.1`), which supertest cannot send. */
async function absoluteGet(app: HvwaApp, target: string, host: string): Promise<{ status: number; setCookie: unknown }> {
  const { port } = serve(app).address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers: { Host: host }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('portal mode: what is mounted', () => {
  it('signed out: every page goes to /login; /login, /register, /healthz and /static are open', async () => {
    const { app } = portalApp();
    for (const path of ['/', '/labs/r01', '/leaderboard', '/no-such-page']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.location, path).toBe(`/login?next=${encodeURIComponent(path)}`);
    }
    for (const path of ['/login', '/register', '/healthz', '/static/app.css']) expect((await request(app).get(path)).status, path).toBe(200);
  });

  it('serves the friendly lab-gone page for an instance host whose container is gone', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'goneplayer');
    const res = await agent.get('/lab-gone');
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer running');
    expect(res.text).toContain('Back to the Guild Hall');
    expect(res.text).toContain('href="/"');
    const host = `i-${'a'.repeat(26)}.${DOMAIN}`;
    const retry = await agent.get(`/lab-gone?i=${host}`);
    expect(retry.text).toContain('Try the lab again');
    expect(retry.text).toContain(`href="https://${host}"`);
    const evil = await agent.get('/lab-gone?i=i-' + 'a'.repeat(26) + '.evil.example');
    expect(evil.text).not.toContain('Try the lab again');
  });

  it('mounts no labs, no standalone portal pages, no admin pages and no JSON API, even signed in', async () => {
    const { app } = portalApp();
    expect(app.locals.mode).toBe('portal');
    expect(app.locals.challenges.all()).toEqual([]);
    const { agent } = await player(app, 'alice');
    for (const path of ['/d/gatekeeper/sqli-login', '/d/gatekeeper', '/c/GK-01', '/scoreboard', '/api/submit', '/admin/users']) {
      expect((await agent.get(path)).status, path).toBe(404);
    }
    expect((await agent.post('/api/submit').send({ challengeId: 'GK-01', submission: 'x' })).status).toBe(404);
    const admin = await signInAdmin(app);
    for (const path of ['/admin/users', '/admin/range', '/admin/settings']) expect((await admin.get(path)).status, path).toBe(404);
  });

  it('needs its range options and the login', () => {
    expect(() => createApp({ flagSecret: TEST_SECRET, mode: 'portal' })).toThrow(/range/);
    expect(() => createApp({ flagSecret: TEST_SECRET, mode: 'portal', auth: false, range: rangeOptions() })).toThrow(/login/);
  });

  it('standalone stays the default (HVWA_MODE unset): labs mounted, no range', () => {
    const app = createApp({ flagSecret: TEST_SECRET });
    expect(app.locals.mode).toBe('standalone');
    expect(app.locals.range).toBeUndefined();
    expect(app.locals.challenges.all().length).toBeGreaterThan(0);
    app.locals.db.close();
  });

  it('fails closed on instance hosts, the internal host and /__hvwa/* of the portal host; other hosts are 421', async () => {
    const { app } = portalApp();
    const lab = `i-${'a'.repeat(26)}.${DOMAIN}`;
    for (const [host, path] of [[lab, '/'], [lab, '/__hvwa/other'], ['portal', '/'], [DOMAIN, '/__hvwa/gate'],
      [DOMAIN, '/__HVWA/gate'], [`${lab.toUpperCase()}:443`, '/login']]) {
      const res = await request(app).get(path).set('Host', host);
      expect(res.status, `${host}${path}`).toBe(404);
      expect(res.headers['set-cookie'], `${host}${path}`).toBeUndefined();
      expect(res.headers['cache-control'], `${host}${path}`).toBe('no-store');
    }
    // Task 20: the gate path itself answers (401 without a valid ticket), still never with a portal cookie.
    const gated = await request(app).get('/__hvwa/gate?t=x').set('Host', lab);
    expect(gated.status).toBe(401);
    expect(gated.headers['set-cookie']).toBeUndefined();
    // Task 21: the internal host's forward-auth refuses a caller without the shared secret (403), never a portal cookie.
    const auth = await request(app).get('/__hvwa/auth').set('Host', 'portal');
    expect(auth.status).toBe(403);
    expect(auth.headers['set-cookie']).toBeUndefined();
    expect((await request(app).get('/').set('Host', 'evil.example')).status).toBe(421);
    expect((await request(app).get('/').set('Host', `i-${'a'.repeat(25)}.${DOMAIN}`)).status).toBe(421);
  });

  it('an absolute-form target naming an instance host is answered by the edge, whatever the Host says', async () => {
    const { app } = portalApp();
    const lab = `i-${'a'.repeat(26)}.${DOMAIN}`;
    for (const r of [await absoluteGet(app, `http://${lab}/`, DOMAIN), await absoluteGet(app, `http://portal/login`, DOMAIN)]) {
      expect(r.status).toBe(404);
      expect(r.setCookie).toBeUndefined();
    }
    expect((await absoluteGet(app, `http://${DOMAIN}/`, DOMAIN)).status).toBe(303); // the portal itself: to the login
  });
});

describe('portal-mode login options', () => {
  it('behind the tunnel by default (public scheme https): hvwa_auth is Secure, a form Origin must be https, 10-character passwords', async () => {
    const app = createApp({
      flagSecret: TEST_SECRET, mode: 'portal', auth: { initialPassword: ADMIN_PASSWORD, hasher: FAST_HASHER }, range: rangeOptions(),
    });
    onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed */ } });
    expect(app.locals.auth?.passwordMinLength).toBe(10);
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').set('Host', DOMAIN);
    expect(setCookieHeader(loginPage, 'hvwa_sid')).toMatch(/;\s*Secure/i);
    // supertest speaks plain http, so a Secure hvwa_sid is not replayed by the jar: send it by hand to keep the CSRF
    // token bound to the same session (exactly what a real https browser does).
    const cookie = `hvwa_sid=${setCookieValue(loginPage, 'hvwa_sid')}`;
    const form = { _csrf: csrfOf(loginPage.text), username: 'admin', password: ADMIN_PASSWORD };
    const plain = await agent.post('/login').set('Host', DOMAIN).set('Cookie', cookie).set('Origin', `http://${DOMAIN}`)
      .type('form').send(form);
    expect(plain.status).toBe(403);
    const ok = await agent.post('/login').set('Host', DOMAIN).set('Cookie', cookie).set('Origin', `https://${DOMAIN}`)
      .type('form').send(form);
    expect(ok.status).toBe(303);
    expect(setCookieHeader(ok, 'hvwa_auth')).toMatch(/;\s*Secure/i);
  });

  it('a local run (public scheme http): hvwa_auth is not Secure and the Origin is http', async () => {
    const app = createApp({
      flagSecret: TEST_SECRET, mode: 'portal', auth: { initialPassword: ADMIN_PASSWORD, hasher: FAST_HASHER },
      range: { ...rangeOptions(), publicScheme: 'http' },
    });
    onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed */ } });
    const agent = request.agent(app);
    const page = await agent.get('/login?lang=id').set('Host', DOMAIN);
    expect(setCookieHeader(page, 'hvwa_sid')).not.toMatch(/Secure/i);
    expect(setCookieHeader(page, 'hvwa_lang')).not.toMatch(/Secure/i);
    const form = { _csrf: csrfOf(page.text), username: 'admin', password: ADMIN_PASSWORD };
    const ok = await agent.post('/login').set('Host', DOMAIN).set('Origin', `http://${DOMAIN}`).type('form').send(form);
    expect(ok.status).toBe(303);
    expect(setCookieHeader(ok, 'hvwa_auth')).not.toMatch(/Secure/i);
  });

  it('registration is open unless registrationOpen is false (HVWA_REGISTRATION_OPEN=0)', async () => {
    expect((await request(portalApp().app).get('/register')).status).toBe(200);
    const closed = portalApp({ range: { registrationOpen: false } }).app;
    expect((await request(closed).get('/register')).status).toBe(403);
    expect((await request(closed).get('/login')).text).not.toContain('href="/register"');
  });

  it('failed sign-ins are budgeted per client IP (30 per 15 minutes), in front of the per-account backoff', async () => {
    const { app } = portalApp();
    const agent = request.agent(app);
    const csrf = csrfOf((await agent.get('/login')).text);
    const attempt = (ip: string, n: number) => agent.post('/login').set('CF-Connecting-IP', ip).type('form')
      .send({ _csrf: csrf, username: `nobody${n}`, password: 'Wrong-Pass-1' });
    for (let i = 0; i < 30; i++) expect((await attempt('203.0.113.7', i)).status).toBe(401);
    expect((await attempt('203.0.113.7', 30)).status).toBe(429);
    expect((await attempt('203.0.113.8', 31)).status).toBe(401);
  });
});

describe('the catalog', () => {
  it('lists every registry lab: app, title, category, difficulty badge, scenario and level chips', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/')).text;
    const cards = [...html.matchAll(/data-testid="lab-card" data-lab="(r\d{2})" data-difficulty="([a-z]+)" data-solved="(true|false)"/g)]
      .map((m) => m.slice(1).join(':'));
    expect(cards).toEqual(['r01:easy:false', 'r02:medium:false']);
    for (const text of ['App clinic', 'clinic title', 'Scenario of clinic', 'SQL injection', 'Easy', 'Medium', 'Broken access control']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('href="/labs/r01"');
  });

  it('filters by category, difficulty and solved state (a GET form: no JavaScript), ignoring unknown values', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r02', 'acolyte', 200, T0);
    const ids = async (q: string) => [...(await agent.get(`/${q}`)).text.matchAll(/data-lab="(r\d{2})"/g)].map((m) => m[1]);
    expect(await ids('?difficulty=medium')).toEqual(['r02']);
    expect(await ids(`?category=${encodeURIComponent('SQL injection')}`)).toEqual(['r01']);
    expect(await ids('?show=done')).toEqual(['r02']);
    expect(await ids('?show=todo')).toEqual(['r01']);
    expect(await ids('?difficulty=insane&category=%3Cx%3E')).toEqual(['r01', 'r02']);
    expect((await agent.get('/')).text).toContain('data-testid="range-score">220<');
  });

  it('searches and sorts (a GET form), and shows a solved-progress bar', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r02', 'acolyte', 200, T0);
    const ids = async (q: string) => [...(await agent.get(`/${q}`)).text.matchAll(/data-lab="(r\d{2})"/g)].map((m) => m[1]);
    expect(await ids('?q=courier')).toEqual(['r02']);
    expect(await ids('?q=nothing-matches')).toEqual([]);
    expect((await agent.get('/?q=nothing-matches')).text).toContain('data-testid="empty-clear"');
    expect(await ids('?sort=solved')).toEqual(['r02', 'r01']);
    expect(await ids('?sort=difficulty')).toEqual(['r01', 'r02']);
    const html = (await agent.get('/')).text;
    expect(html).toMatch(/data-testid="range-progress" max="2" value="1"/);
    expect(html).not.toContain('data-testid="empty-clear"');
  });

  it('shows the adventurer rank (seal letter + name + progress) derived from bounty points', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    const fresh = (await agent.get('/')).text;
    expect(fresh).toContain('data-testid="range-rank"');
    expect(fresh).toContain('Greenhorn'); // the 20 G starter purse → E Greenhorn (Copper); the test labs pay 400 in all
    expect(fresh).toMatch(/data-testid="range-rank-progress" max="40" value="20"/);
    expect(fresh).toMatch(/data-testid="account-nav"[\s\S]*?class="menu-rank"[\s\S]*?Greenhorn/); // the account menu shows the rank
    recordRangeSolve(app.locals.db, userId, 'r01', 'templar', 150, T0);
    recordRangeSolve(app.locals.db, userId, 'r02', 'acolyte', 200, T0); // 370 → A Champion, next S at 380 (95% of 400)
    const html = (await agent.get('/')).text;
    expect(html).toContain('Champion');
    expect(html).toMatch(/data-testid="range-rank-progress" max="380" value="370"/);
  });

  it('gives each lab its own theme class and icon, and a Continue hero for an active instance', async () => {
    const kit = portalApp();
    const { agent, userId } = await player(kit.app, 'alice');
    const html = (await agent.get('/')).text;
    expect(html).toContain('lab-card lab-theme-theme-clinic');
    expect(html).toContain('data-theme="theme-clinic"');
    expect(html).toContain('/static/icons.svg#i-ill-courier'); // courier's identity illustration
    await kit.app.locals.range!.lifecycle.launch(userId, 'r01', 'templar');
    const hero = (await agent.get('/')).text;
    expect(hero).toMatch(/data-testid="continue-lab" data-state="starting"/);
    expect(hero).toContain('Quest in hand');
    expect(hero).toContain('App clinic');
    expect(hero).toContain('href="/labs/r01?level=templar"');
  });

  it('pins each bounty on its guild board: one carousel slide per track, a sign per board, "soon" on an empty one', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/')).text;
    for (const track of TRACKS) {
      expect(html).toContain(`id="board-${track}" data-board="${track}"`);
      expect(html).toContain(`href="#board-${track}" data-board-link`);
    }
    const slice = (from: string, to: string) => html.slice(html.indexOf(`id="board-${from}"`), html.indexOf(`id="board-${to}"`));
    expect(slice('web', 'crypto')).toContain('data-lab="r01"'); // every lab defaults to the web board
    expect(slice('crypto', 'pwn')).not.toContain('data-testid="lab-card"');
    expect(slice('crypto', 'pwn')).toContain('No bounties pinned here yet');
    expect(html).toMatch(/data-testid="board-sign-web" aria-current="true"/); // the first board is the active one
    expect(html).toContain('data-board-prev hidden'); // the arrow knobs wait for ui.js; the plank links work without it
  });

  it('shows the Indonesian texts with ?lang=id, and every value escaped', async () => {
    const { app } = portalApp({ range: { registry: parseRegistry({ schema: 1, labs: [labEntry('r01', 'clinic', { app: '<b>App</b>' })] }) } });
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/?lang=id')).text;
    expect(html).toContain('judul clinic');
    expect(html).toContain('Skenario clinic');
    expect(html).toContain('&lt;b&gt;App&lt;/b&gt;');
    expect(html).not.toContain('<b>App</b>');
  });
});

describe('a lab page', () => {
  it('briefing, scenario and a level picker with points (Easy: 100 / 150 / 200, Divine not scored); ?level= is clamped', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/labs/r01?level=templar')).text;
    expect(html).toContain('Briefing of clinic');
    for (const [level, text] of [['acolyte', '100'], ['templar', '150'], ['inquisitor', '200']]) {
      expect(html).toMatch(new RegExp(`data-testid="range-level-${level}"[^>]*>[\\s\\S]*?${text} `));
    }
    expect(html).toMatch(/data-testid="range-level-templar"[^>]*aria-current="true"/);
    const courier = (await agent.get('/labs/r02?level=inquisitor')).text; // r02 has acolyte + divine: clamped to acolyte
    expect(courier).toMatch(/data-testid="range-level-acolyte"[^>]*aria-current="true"/);
    expect((await agent.get('/labs/r99')).status).toBe(404);
  });

  it('a scroll from the merchant buys one counsel: gold is spent at purchase, the Guildmaster reads it once', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r01', 'acolyte', 100, T0);
    expect((await agent.post('/labs/r01/hint').type('form').send({ tier: '1' })).status).toBe(403);
    const csrf = csrfOf((await agent.get('/labs/r01')).text);
    expect((await agent.post('/labs/r01/hint').set('Origin', 'https://evil.example').type('form').send({ _csrf: csrf, tier: '1' })).status)
      .toBe(403);
    expect((await agent.get('/')).text).toContain('data-testid="range-score">120<');
    // No scroll yet: the Guildmaster sends the player to the merchant.
    const none = await agent.post('/labs/r01/hint').type('form').send({ _csrf: csrf, tier: '1' });
    expect(none.status).toBe(303);
    expect(none.headers.location).toBe('/shop?need=insight&from=r01');
    const noneHx = await agent.post('/labs/r01/hint').set('HX-Request', 'true').type('form').send({ _csrf: csrf, tier: '1' });
    expect(noneHx.status).toBe(400);
    expect(noneHx.text).toContain('data-error="no_scroll"');
    // Buying spends the gold at once.
    const shop = await agent.get('/shop?need=insight&from=r01');
    expect(shop.status).toBe(200);
    expect(shop.text).toContain('data-testid="ware-insight"');
    expect((await agent.post('/shop/buy').type('form').send({ kind: 'insight' })).status).toBe(403);
    const bought = await agent.post('/shop/buy').type('form').send({ _csrf: csrfOf(shop.text), kind: 'insight', from: 'r01' });
    expect(bought.status).toBe(303);
    expect(bought.headers.location).toBe('/shop?bought=insight&from=r01');
    expect((await agent.get('/')).text).toContain('data-testid="range-score">110<');
    expect((await agent.get('/shop')).text).toContain('data-testid="scroll-count-insight">1<');
    const res = await agent.post('/labs/r01/hint').set('HX-Request', 'true').type('form').send({ _csrf: csrf, tier: '1' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hint one of clinic');
    expect(res.text).toMatch(/data-toast="unlocked"/);
    expect(res.text).toMatch(/data-toast-variant="success"/);
    expect(res.text).toMatch(/data-toast-message="The Guildmaster read your Scroll of Insight"/);
    // Heard once: asking again uses no second scroll and costs nothing more.
    const again = await agent.post('/labs/r01/hint').type('form').send({ _csrf: csrf, tier: '1' });
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe('/labs/r01#hint-1');
    expect((await agent.get('/shop')).text).toContain('data-testid="scroll-count-insight">0<');
    expect((await agent.get('/')).text).toContain('data-testid="range-score">110<');
    expect((await agent.get('/labs/r01')).text).toMatch(/data-tier="1">Hint one of clinic</);
    expect((await agent.post('/labs/r01/hint').set('HX-Request', 'true').type('form').send({ _csrf: csrf, tier: '3' })).status).toBe(400);
    expect((await agent.post('/labs/r99/hint').type('form').send({ _csrf: csrf, tier: '1' })).status).toBe(404);
    expect((await agent.post('/shop/buy').type('form').send({ _csrf: csrf, kind: 'elixir' })).headers.location).toBe('/shop');
  });

  it('a new adventurer gets the starter purse once with its popup; a scroll the purse cannot pay for is refused', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    app.locals.db.prepare("INSERT OR IGNORE INTO avatars (user_id, spec, updated_at) VALUES (?, '{\"hero\":\"kael\"}', 1)").run(userId);
    const hall = (await agent.get('/')).text;
    expect(hall).toContain('data-testid="starter-gift"');
    expect(hall).toContain('data-amount="20"');
    expect(hall).toContain('data-testid="range-score">20<');
    expect((await agent.get('/')).text).not.toContain('data-testid="starter-gift"'); // shown once
    const shop = (await agent.get('/shop')).text;
    expect(shop).toContain('data-testid="short-oracle"');
    expect(shop).toMatch(/disabled[^>]*data-testid="buy-oracle"/);
    expect(shop).not.toContain('data-testid="short-revelation"');
    const csrf = csrfOf(shop);
    const poor = await agent.post('/shop/buy').type('form').send({ _csrf: csrf, kind: 'oracle' });
    expect(poor.headers.location).toBe('/shop?poor=oracle');
    expect((await agent.get('/shop?poor=oracle')).text).toContain('10 G short for the Scroll of the Oracle');
    expect((await agent.post('/shop/buy').type('form').send({ _csrf: csrf, kind: 'revelation' })).headers.location).toBe('/shop?bought=revelation');
    expect((await agent.get('/shop')).text).toContain('data-testid="scroll-count-revelation">1<');
    expect((await agent.post('/shop/buy').type('form').send({ _csrf: csrf, kind: 'insight' })).headers.location).toBe('/shop?poor=insight');
    expect((await agent.get('/')).text).toContain('data-testid="range-score">0<');
  });

  it('a locked hint never shows its text', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    expect((await agent.get('/labs/r01')).text).not.toContain('Hint one of clinic');
  });
});

describe('the leaderboard and the navigation', () => {
  it('ranks players by score, then by the earlier last solve; marks the viewer', async () => {
    const { app } = portalApp();
    const a = await player(app, 'alice');
    const b = await player(app, 'bob');
    recordRangeSolve(app.locals.db, a.userId, 'r01', 'templar', 150, T0 + 2);
    recordRangeSolve(app.locals.db, b.userId, 'r01', 'templar', 150, T0 + 1);
    const html = (await a.agent.get('/leaderboard')).text;
    expect([...html.matchAll(/data-rank="(\d+)" data-user="([a-z_0-9]+)"/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(['1:bob', '2:alice']);
    expect(html).toMatch(/data-user="alice"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/data-user="bob"[^>]*aria-current="true"/);
  });

  it('emphasises the top three and pins the viewer\'s row when it is outside them', async () => {
    const { app } = portalApp();
    const a = await player(app, 'alice');
    const b = await player(app, 'bob');
    const c = await player(app, 'carol');
    const d = await player(app, 'dave');
    recordRangeSolve(app.locals.db, a.userId, 'r01', 'acolyte', 100, T0 + 4);
    recordRangeSolve(app.locals.db, b.userId, 'r01', 'acolyte', 400, T0 + 1);
    recordRangeSolve(app.locals.db, c.userId, 'r01', 'acolyte', 300, T0 + 2);
    recordRangeSolve(app.locals.db, d.userId, 'r01', 'acolyte', 200, T0 + 3);
    const html = (await a.agent.get('/leaderboard')).text;
    expect(html).toMatch(/data-rank="1" data-user="bob" class="leaderboard-top leaderboard-top-1/);
    expect(html).toMatch(/data-rank="3" data-user="dave" class="leaderboard-top leaderboard-top-3/);
    expect(html).toContain('data-testid="leaderboard-you"');
    expect(html).toMatch(/data-testid="leaderboard-you"[\s\S]*?data-rank="4" data-user="alice"/);
    expect(html).toContain('Your position');
    expect(html).toContain('Top 100%'); // 4th of 4
    expect(html).toContain('101 G to pass dave'); // dave has 200, alice 100: one more than the gap
  });

  it('counts one member in the singular and keeps the position separate from the rank seal', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r01', 'acolyte', 100, T0);
    const html = (await agent.get('/leaderboard')).text;
    expect(html).toContain('1 adventurer');
    expect(html).not.toContain('1 adventurers');
    expect(html).toMatch(/data-rank="1" data-user="alice"/);
    expect(html).toContain('class="podium-rank"'); // the numeric position
    expect(html).toContain('class="rank-seal'); // the adventurer rank seal (letter)
  });

  it('opens the guild gate once on the first page after signing in, then never again', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice'); // signs in: the hvwa_welcome marker is set
    const first = await agent.get('/');
    expect(first.text).toContain('data-testid="welcome-gate"');
    expect(first.text).toContain('Welcome back, alice');
    expect(setCookieHeader(first, 'hvwa_welcome')).toMatch(/^hvwa_welcome=;/); // consumed
    expect((await agent.get('/leaderboard')).text).not.toContain('data-testid="welcome-gate"');
  });

  it('Labs and Leaderboard for everyone; an Admin link only for admins; no Districts or Scoreboard links', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const playerHtml = (await agent.get('/')).text;
    expect(playerHtml).toContain('data-testid="nav-labs"');
    expect(playerHtml).toContain('data-testid="nav-leaderboard"');
    expect(playerHtml).not.toContain('data-testid="nav-admin"');
    expect(playerHtml).not.toContain('href="/scoreboard"');
    const adminHtml = (await (await signInAdmin(app)).get('/')).text;
    expect(adminHtml).toContain('data-testid="nav-labs"');
    expect(adminHtml).toContain('data-testid="nav-leaderboard"');
    expect(adminHtml).toContain('data-testid="nav-admin"');
    expect(adminHtml).not.toContain('href="/scoreboard"');
    expect((await agent.get('/')).text).toMatch(/data-testid="nav-labs"[^>]*aria-current="page"/);
    expect((await agent.get('/leaderboard')).text).toMatch(/data-testid="nav-leaderboard"[^>]*aria-current="page"/);
  });
});

describe('portal copy and per-user headers', () => {
  it('the public range shows no safety strip and never claims to run offline; the standalone shell keeps its warning', async () => {
    const { app } = portalApp();
    const login = (await request(app).get('/login')).text;
    expect(login).not.toContain('class="safety-banner"');
    expect(login).not.toContain('Every lab is deliberately vulnerable');
    expect(login).not.toContain('Runs fully offline');
    const { agent } = await player(app, 'alice');
    for (const path of ['/', '/leaderboard', '/labs/r01']) {
      const html = (await agent.get(path)).text;
      expect(html, path).not.toContain('class="safety-banner"');
      expect(html, path).not.toContain('Runs fully offline');
      expect(html, path).not.toContain('Never expose it to an untrusted network');
      expect(html, path).not.toContain('Nothing is sent anywhere');
    }
    const standalone = createApp({ flagSecret: TEST_SECRET });
    onTestFinished(() => { try { standalone.locals.db.close(); } catch { /* closed */ } });
    const old = (await request(standalone).get('/')).text;
    expect(old).toContain('data-mode="standalone"');
    expect(old).toContain('Runs fully offline');
    expect(old).toContain('Never expose it to an untrusted network');
  });

  it('per-user pages and fragments are private, cookie-varied, nosniff and CSP-scoped', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    for (const path of ['/', '/leaderboard', '/labs/r01', '/labs/r01/panel?level=acolyte', '/my-lab/chip']) {
      const res = await agent.get(path).set('HX-Request', 'true');
      expect(res.status, path).toBe(200);
      expect(res.headers['cache-control'], path).toBe('private, no-store');
      expect(String(res.headers.vary), path).toMatch(/Cookie/i);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['content-security-policy'], path).toContain("default-src 'self'");
      expect(res.headers['content-security-policy'], path).toContain("frame-ancestors 'self'");
    }
  });

  it('a stale CSRF token on an htmx form is a tiny fragment + HX-Refresh, never a full page; the refusal keeps the scoped CSP', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    for (const [path, body] of [
      ['/labs/r01/hint', { tier: '1' }], ['/labs/r01/launch', { level: 'acolyte' }], ['/labs/r01/submit', { submission: 'HVWA{x}' }],
    ] as const) {
      const res = await agent.post(path).set('HX-Request', 'true').type('form').send({ _csrf: 'stale', ...body });
      expect(res.status, path).toBe(403);
      expect(res.headers['hx-refresh'], path).toBe('true');
      expect(res.text, path).not.toContain('<!doctype html>');
      expect(res.text, path).toContain('data-error="csrf"');
      // noStore() must preserve the router's scoped policy, not replace it with frame-ancestors 'none'.
      expect(res.headers['content-security-policy'], path).toContain("default-src 'self'");
      expect(res.headers['content-security-policy'], path).toContain("frame-ancestors 'self'");
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(String(res.headers.vary), path).toMatch(/Cookie/i);
    }
    expect(kit.warden.launched).toEqual([]); // a refused launch started nothing
    const plain = await agent.post('/labs/r01/launch').type('form').send({ _csrf: 'stale', level: 'acolyte' });
    expect(plain.status).toBe(403);
    expect(plain.text).toContain('<!doctype html>'); // a normal page keeps the full refusal page
    expect(plain.headers['content-security-policy']).toContain("default-src 'self'");
    expect(plain.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  it('the login and account pages (outside portal.router) carry the same scoped CSP, nosniff and Vary: Cookie', async () => {
    const kit = portalApp();
    const login = await request(kit.app).get('/login');
    expect(login.status).toBe(200);
    const account = await (await player(kit.app, 'alice')).agent.get('/account/password');
    expect(account.status).toBe(200);
    for (const [path, res] of [['/login', login], ['/account/password', account]] as const) {
      expect(res.headers['content-security-policy'], path).toContain("default-src 'self'");
      expect(res.headers['content-security-policy'], path).toContain("frame-ancestors 'self'");
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(String(res.headers.vary), path).toMatch(/Cookie/i);
    }
    // A refused account form keeps them too (noStore() preserves what the router set).
    const refused = await (await player(kit.app, 'bob')).agent.post('/account/password').type('form').send({ _csrf: 'stale' });
    expect(refused.status).toBe(403);
    expect(refused.headers['content-security-policy']).toContain("default-src 'self'");
    expect(refused.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });
});

describe('range ids and hosts', () => {
  it('base32 is RFC 4648 in lower case without padding; an instance id is 128 bits in 26 characters', () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(enc)).toEqual(['', 'my', 'mzxq', 'mzxw6', 'mzxw6yq', 'mzxw6ytb', 'mzxw6ytboi']);
    const ids = new Set(Array.from({ length: 50 }, () => newInstanceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(INSTANCE_ID_RE);
  });

  it('instance hosts are one level deep; origins carry a port only when it is not the scheme default', () => {
    const id = 'a'.repeat(26);
    expect(instanceHost(id, DOMAIN)).toBe(`i-${id}.${DOMAIN}`);
    expect(instanceIdOfHost(`i-${id}.${DOMAIN}`, DOMAIN)).toBe(id);
    for (const h of [`i-${id}.x.${DOMAIN}`, `i-${id}x.${DOMAIN}`, `c-${id}.${DOMAIN}`, `i-${id}.other.test`, `i-${'A'.repeat(26)}.${DOMAIN}`, DOMAIN]) {
      expect(instanceIdOfHost(h, DOMAIN), h).toBeUndefined();
    }
    expect(instanceOrigin(id, DOMAIN)).toBe(`https://i-${id}.${DOMAIN}`);
    expect(instanceOrigin(id, DOMAIN, 'https', 443)).toBe(`https://i-${id}.${DOMAIN}`);
    expect(instanceOrigin(id, 'localhost', 'http', 18080)).toBe(`http://i-${id}.localhost:18080`);
    expect(portalOrigin('hvwa.localhost', 'http', 80)).toBe('http://hvwa.localhost');
    expect(portalOrigin(DOMAIN)).toBe(`https://${DOMAIN}`);
  });
});
