import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { perSession } from '../src/core/lab.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { flagFor, challengePath } from '../src/core/mount.js';
import { freshSession, TEST_SECRET } from './helpers.js';

const SECRET_DETAIL = 'mount-internal-detail-xyz';

// Registered at import time, before any createApp() — exactly how districts work.
const MT01 = register(defineChallenge({
  id: 'MT-01', district: 'mount-test', dir: process.cwd(), slug: 'clamp-lab',
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [],
  levels: ['acolyte', 'inquisitor', 'divine'], hints: [],
  mount: (router) => {
    router.get('/', (req, res) => {
      res.json({ level: req.level, localsLevel: res.locals.level, challenge: res.locals.challenge?.id, labPath: res.locals.labPath });
    });
    router.get('/flag', (req, res) => { res.json({ flag: flagFor(req, MT01) }); });
    router.get('/boom', () => { throw new Error(SECRET_DETAIL); });
  },
}));

describe('mountChallenges', () => {
  it('serves a registered challenge at /d/<district>/<slug> with relative routes', async () => {
    expect(challengePath(MT01)).toBe('/d/mount-test/clamp-lab');
    const res = await request(createApp()).get('/d/mount-test/clamp-lab');
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('MT-01');
  });

  it('clamps the requested level to the challenge: templar → acolyte', async () => {
    const res = await request(createApp()).get('/d/mount-test/clamp-lab').set('Cookie', 'hvwa_level=templar');
    expect(res.body).toEqual({ level: 'acolyte', localsLevel: 'acolyte', challenge: 'MT-01', labPath: '/d/mount-test/clamp-lab' });
  });

  it('keeps implemented levels as requested', async () => {
    const app = createApp();
    expect((await request(app).get('/d/mount-test/clamp-lab?level=inquisitor')).body.level).toBe('inquisitor');
    expect((await request(app).get('/d/mount-test/clamp-lab?level=divine')).body.level).toBe('divine');
  });

  it('flagFor() issues a flag that /api/submit credits at the clamped level', async () => {
    const { agent } = await freshSession();
    const { flag } = (await agent.get('/d/mount-test/clamp-lab/flag?level=inquisitor')).body;
    const res = await agent.post('/api/submit').send({ challengeId: 'MT-01', submission: flag });
    expect(res.body).toMatchObject({ solved: true, level: 'inquisitor', points: 200 });
  });

  it('flagFor() under a clamped templar request yields an acolyte flag', async () => {
    const { agent } = await freshSession();
    const { flag } = (await agent.get('/d/mount-test/clamp-lab/flag?level=templar')).body;
    const res = await agent.post('/api/submit').send({ challengeId: 'MT-01', submission: flag });
    expect(res.body).toMatchObject({ solved: true, level: 'acolyte', points: 100 });
  });

  it('flagFor() throws on Divine', () => {
    expect(() => flagFor({ sessionId: 's', level: 'divine' }, MT01)).toThrow(/divine/i);
  });

  it('a Divine flag request inside a challenge route is a stack-free 500', async () => {
    const res = await request(createApp({ flagSecret: TEST_SECRET })).get('/d/mount-test/clamp-lab/flag?level=divine');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toMatch(/divine|\n\s+at |\.ts:\d+/i);
  });

  it('an error thrown in a challenge route goes through the no-stack error handler', async () => {
    const res = await request(createApp()).get('/d/mount-test/clamp-lab/boom');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SECRET_DETAIL);
    expect(res.text).not.toMatch(/\n\s+at /);
  });

  it('res.locals.labPath is the canonical lab path, whatever the spelling of the request URL', async () => {
    const app = createApp();
    for (const url of ['/d/mount-test/clamp-lab', '/D/MOUNT-TEST/CLAMP-LAB', '/d/Mount-Test/clamp-lab/']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.body.labPath, url).toBe('/d/mount-test/clamp-lab');
    }
  });

  it('mounts POST <lab>/_reset only for a challenge with a reset hook: it calls it with the session and level, then 303s back', async () => {
    const calls: { sessionId: string; level: string }[] = [];
    register(defineChallenge({
      id: 'MT-03', district: 'mount-test', dir: process.cwd(), slug: 'resettable', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
      mount: (router) => { router.get('/', (_req, res) => { res.send('ok'); }); },
      reset: (req) => { calls.push({ sessionId: req.sessionId, level: req.level }); },
    }));
    const s2 = await freshSession(createApp({ flagSecret: TEST_SECRET }));
    const res = await s2.agent.post('/d/mount-test/resettable/_reset?level=divine');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/d/mount-test/resettable?level=divine');
    expect(calls).toEqual([{ sessionId: s2.sid, level: 'divine' }]);
    // GET is not a reset, and a challenge without a hook has no such route.
    expect((await s2.agent.get('/d/mount-test/resettable/_reset')).status).toBe(404);
    expect((await s2.agent.post('/d/mount-test/clamp-lab/_reset')).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('/_reset has a per-(session, level) cooldown (injectable clock): 429 while cooling, the hook is not called', async () => {
    const calls: string[] = [];
    register(defineChallenge({
      id: 'MT-04', district: 'mount-test', dir: process.cwd(), slug: 'cooldown', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [], resetCooldownMs: 5000,
      mount: (router) => { router.get('/', (_req, res) => { res.send('ok'); }); },
      reset: (req) => { calls.push(`${req.level}|${req.sessionId}`); },
    }));
    register(defineChallenge({
      id: 'MT-05', district: 'mount-test', dir: process.cwd(), slug: 'default-cooldown', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte'], hints: [],
      mount: (router) => { router.get('/', (_req, res) => { res.send('ok'); }); },
      reset: () => { calls.push('default'); },
    }));
    let t = 1_000_000;
    const s = await freshSession(createApp({ flagSecret: TEST_SECRET, resetClock: () => t }));
    const reset = (lab: string, level: string) => s.agent.post(`/d/mount-test/${lab}/_reset?level=${level}`);
    expect((await reset('cooldown', 'acolyte')).status).toBe(303);
    t += 4999;
    const cooling = await reset('cooldown', 'acolyte');
    expect(cooling.status).toBe(429);
    expect(cooling.text).toMatch(/cooling down/);
    // A browser form post (Accept: text/html) is sent back to the lab with a visible notice instead of a bare 429.
    const browser = await reset('cooldown', 'acolyte').set('Accept', 'text/html,application/xhtml+xml');
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toBe('/d/mount-test/cooldown?level=acolyte&restart=cooldown');
    expect(calls).toHaveLength(1); // still not called
    expect((await reset('cooldown', 'divine')).status).toBe(303); // another level: its own cooldown
    expect(calls).toHaveLength(2);
    t += 2;
    expect((await reset('cooldown', 'acolyte')).status).toBe(303);
    // The default cooldown is 10 s.
    expect((await reset('default-cooldown', 'acolyte')).status).toBe(303);
    t += 9999;
    expect((await reset('default-cooldown', 'acolyte')).status).toBe(429);
    t += 2;
    expect((await reset('default-cooldown', 'acolyte')).status).toBe(303);
    // Another player is not cooled by this one.
    const other = await freshSession(createApp({ flagSecret: TEST_SECRET, resetClock: () => t }));
    expect((await other.agent.post('/d/mount-test/default-cooldown/_reset')).status).toBe(303);
  });

  it('rejects a bad resetCooldownMs', () => {
    for (const resetCooldownMs of [-1, 1.5, Number.NaN]) {
      expect(() => defineChallenge({
        id: 'MT-06', district: 'mount-test', dir: process.cwd(), slug: 'bad-cd', title: { id: 't', en: 't' },
        summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte'], hints: [], mount: () => {}, reset: () => {}, resetCooldownMs,
      }), String(resetCooldownMs)).toThrow(/resetCooldownMs/);
    }
  });

  it('a cookieless flood cannot reset a locked lab: the app issues at most N sessions a minute, and a forged-cookie flood hits the holder limit', async () => {
    const holder = perSession(() => ({ locked: false }), { maxEntries: 50, maxNewPerMinute: 10, now: () => 0 });
    register(defineChallenge({
      id: 'MT-07', district: 'mount-test', dir: process.cwd(), slug: 'flood', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte'], hints: [],
      mount: (router) => {
        router.post('/lock', (req, res) => { holder.for(req).locked = true; res.json({ ok: true }); });
        router.get('/state', (req, res) => { res.json({ locked: holder.for(req).locked }); });
      },
    }));
    const app = createApp({ flagSecret: TEST_SECRET, maxNewSessionsPerMinute: 30, sessionClock: () => 0 });
    const victim = await freshSession(app);
    await victim.agent.post('/d/mount-test/flood/lock');
    const server = createServer(app).listen(0, '127.0.0.1'); // one listener for the whole flood (no port churn)
    try {
    // 1. cookieless flood: only the first few get a session, the rest are 429 before reaching any lab
    let ok = 0;
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      const r = await request(server).post('/d/mount-test/flood/lock');
      if (r.status === 429) refused += 1; else if (r.status === 200) ok += 1;
    }
    expect(ok).toBeLessThanOrEqual(29);
    expect(refused).toBeGreaterThanOrEqual(171);
    // 2. forged-UUID flood: the app cannot tell them from real sessions, the holder's own limit stops it
    for (let i = 0; i < 200; i++) {
      const forged = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await request(server).post('/d/mount-test/flood/lock').set('Cookie', `hvwa_sid=${forged}`);
    }
    const still = await victim.agent.get('/d/mount-test/flood/state');
    expect(still.body).toEqual({ locked: true });
    } finally { server.close(); }
  });

  it('mounts what is registered when createApp() runs', async () => {
    const before = createApp();
    register(defineChallenge({
      id: 'MT-02', district: 'mount-test', dir: process.cwd(), slug: 'late', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte'], hints: [],
      mount: (router) => { router.get('/', (_req, res) => { res.send('late'); }); },
    }));
    expect((await request(before).get('/d/mount-test/late')).status).toBe(404);
    expect((await request(createApp()).get('/d/mount-test/late')).text).toBe('late');
  });
});
