import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { flagFor, challengePath } from '../src/core/mount.js';
import { freshSession, TEST_SECRET } from './helpers.js';

const SECRET_DETAIL = 'mount-internal-detail-xyz';

// Registered at import time, before any createApp() — exactly how districts work.
const MT01 = register(defineChallenge({
  id: 'MT-01', district: 'mount-test', slug: 'clamp-lab',
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [],
  levels: ['acolyte', 'inquisitor', 'divine'], hints: [],
  mount: (router) => {
    router.get('/', (req, res) => {
      res.json({ level: req.level, localsLevel: res.locals.level, challenge: res.locals.challenge?.id });
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
    expect(res.body).toEqual({ level: 'acolyte', localsLevel: 'acolyte', challenge: 'MT-01' });
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

  it('mounts what is registered when createApp() runs', async () => {
    const before = createApp();
    register(defineChallenge({
      id: 'MT-02', district: 'mount-test', slug: 'late', title: { id: 't', en: 't' },
      summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte'], hints: [],
      mount: (router) => { router.get('/', (_req, res) => { res.send('late'); }); },
    }));
    expect((await request(before).get('/d/mount-test/late')).status).toBe(404);
    expect((await request(createApp()).get('/d/mount-test/late')).text).toBe('late');
  });
});
