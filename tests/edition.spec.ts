// HVWA_EDITION / createApp({ edition }): the lite edition serves exactly five challenges, every other one is
// unknown (404) everywhere, and the full edition is unchanged. src/editions.ts holds the one lite list.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import '../src/districts/index.js'; // registers every challenge
import { createApp, type HvwaApp } from '../src/app.js';
import { allChallenges, getChallenge, type Challenge } from '../src/core/registry.js';
import { challengePath } from '../src/core/mount.js';
import { issueFlag } from '../src/core/flags.js';
import { recordSolve } from '../src/core/scoreboard.js';
import { EDITIONS, LITE_CHALLENGE_IDS, editionChallengeIds, isEdition } from '../src/editions.js';
import { TEST_SECRET } from './helpers.js';

const LITE = ['GK-01', 'GK-02', 'GK-12', 'RM-05', 'SC-01'];
const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function liteApp(): HvwaApp { return createApp({ edition: 'lite', flagSecret: TEST_SECRET }); }

/** Challenge ids the portal index links, sorted. */
const indexIds = (html: string) => [...new Set([...html.matchAll(/href="\/c\/([A-Z]{2}-\d{2})"/g)].map((m) => m[1]))].sort(byId);

/** district -> the count its heading shows, from the portal index. */
function districtCounts(html: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of html.matchAll(/data-district="([a-z0-9-]+)">\s*<h2 class="district-name">[^<]*<span class="muted small">\((\d+) /g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

async function browserOn(app: HvwaApp) {
  const agent = request.agent(app);
  const sid = /hvwa_sid=([^;]+)/.exec(String((await agent.get('/healthz')).headers['set-cookie']))?.[1];
  if (!sid) throw new Error('no hvwa_sid');
  return { agent, sid };
}

describe('the edition list (src/editions.ts)', () => {
  it('lite is exactly GK-01, GK-02, GK-12, RM-05 and SC-01, all registered; full is unlimited', () => {
    expect([...LITE_CHALLENGE_IDS]).toEqual(LITE);
    expect(Object.isFrozen(LITE_CHALLENGE_IDS)).toBe(true);
    for (const id of LITE) expect(getChallenge(id), id).toBeDefined();
    expect(editionChallengeIds('lite')).toBe(LITE_CHALLENGE_IDS);
    expect(editionChallengeIds('full')).toBeUndefined();
    expect([...EDITIONS]).toEqual(['full', 'lite']);
    expect(EDITIONS.every(isEdition)).toBe(true);
    for (const x of ['LITE', 'mini', '', undefined, 1]) expect(isEdition(x)).toBe(false);
  });
});

describe('lite edition', () => {
  it('the app reports its edition and serves exactly the five', () => {
    const app = liteApp();
    expect(app.locals.edition).toBe('lite');
    expect(app.locals.challenges.all().map((c) => c.id).sort(byId)).toEqual(LITE);
    expect(app.locals.challenges.only).toEqual(new Set(LITE));
    expect(app.locals.challenges.get('GK-03')).toBeUndefined();
    expect(app.locals.challenges.get('GK-01')).toBe(getChallenge('GK-01'));
  });

  it('the portal lists exactly the five, in their three districts, with adjusted counts', async () => {
    const res = await request(liteApp()).get('/');
    expect(res.status).toBe(200);
    expect(indexIds(res.text)).toEqual(LITE);
    expect(districtCounts(res.text)).toEqual({ gatekeeper: 3, 'relic-market': 1, scriptorium: 1 });
    expect(res.text).not.toContain('data-district="forum-of-pilgrims"');
  });

  it('each of the five serves its challenge page and its lab at every implemented level', async () => {
    const { agent } = await browserOn(liteApp());
    for (const id of LITE) {
      const c = getChallenge(id) as Challenge;
      expect((await agent.get(`/c/${id}`)).status, id).toBe(200);
      for (const level of c.levels) {
        const lab = await agent.get(`${challengePath(c)}?level=${level}`);
        expect(lab.status, `${id} ${level}`).toBe(200);
        expect(lab.text).toContain('data-testid="lab-bar"');
      }
    }
  });

  it('every other challenge is unknown: page, source, diff, submit, hint, lab (every level, sub-paths) and /api all 404', async () => {
    const app = liteApp();
    const { agent, sid } = await browserOn(app);
    const others = allChallenges().filter((c) => !LITE.includes(c.id));
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) {
      const at = c.id;
      expect((await agent.get(`/c/${c.id}`)).status, at).toBe(404);
      expect((await agent.get(`/c/${c.id}/source/${c.levels[0]}`)).status, at).toBe(404);
      expect((await agent.get(`/c/${c.id}/diff`)).status, at).toBe(404);
      expect((await agent.post(`/c/${c.id}/submit`).type('form').send({ submission: 'x' })).status, at).toBe(404);
      expect((await agent.post(`/c/${c.id}/hint`).type('form').send({ tier: '1' })).status, at).toBe(404);
      expect((await agent.get(challengePath(c))).status, at).toBe(404);
      for (const level of c.levels) expect((await agent.get(`${challengePath(c)}?level=${level}`)).status, `${at} ${level}`).toBe(404);
      expect((await agent.get(`${challengePath(c)}/login`)).status, at).toBe(404);
      expect((await agent.post(`${challengePath(c)}/_reset`)).status, at).toBe(404);
      // A REAL flag of the hidden challenge scores nothing: the challenge does not exist here.
      const flag = issueFlag(c.id, sid, 'acolyte');
      const submit = await agent.post('/api/submit').send({ challengeId: c.id, submission: flag });
      expect(submit.status, at).toBe(404);
      expect(submit.body).toEqual({ solved: false, error: 'unknown_challenge' });
      const hint = await agent.post('/api/hint').send({ challengeId: c.id, tier: 1 });
      expect(hint.status, at).toBe(404);
    }
    const board = await agent.get('/scoreboard');
    expect(board.text).toMatch(/data-testid="score">0</);
    expect(board.text).toMatch(/data-testid="solved">0</);
  });

  it('a lite challenge still scores through /api/submit and the portal form', async () => {
    const { agent, sid } = await browserOn(liteApp());
    const api = await agent.post('/api/submit').send({ challengeId: 'GK-01', submission: issueFlag('GK-01', sid, 'acolyte') });
    expect(api.body).toMatchObject({ solved: true, level: 'acolyte' });
    const form = await agent.post('/c/SC-01/submit').type('form').send({ submission: issueFlag('SC-01', sid, 'acolyte') });
    expect(form.status).toBe(303);
    const board = await agent.get('/scoreboard');
    expect(board.text).toMatch(/data-testid="solved">2</);
  });

  it('the scoreboard counts only the lite set (a data dir shared with the full edition holds other solves)', async () => {
    const lite = liteApp();
    const full = createApp({ edition: 'full', flagSecret: TEST_SECRET });
    for (const app of [lite, full]) {
      const { agent, sid } = await browserOn(app);
      const db = app.locals.db;
      recordSolve(db, sid, 'GK-01', 'acolyte', 100);
      recordSolve(db, sid, 'GK-03', 'templar', 150); // not lite
      db.prepare('INSERT INTO hint_unlocks (session_id,challenge_id,tier,cost) VALUES (?,?,?,?)').run(sid, 'GK-03', 1, 40);
      db.prepare('INSERT INTO hint_unlocks (session_id,challenge_id,tier,cost) VALUES (?,?,?,?)').run(sid, 'GK-01', 1, 10);
      const board = (await agent.get('/scoreboard')).text;
      const [score, solved] = app === lite ? [90, 1] : [200, 2];
      expect(board, app.locals.edition).toContain(`data-testid="score">${score}<`);
      expect(board, app.locals.edition).toContain(`data-testid="solved">${solved}<`);
    }
  });
});

describe('full edition (the default)', () => {
  it('is unchanged: lists every registered challenge and serves a non-lite lab', async () => {
    const app = createApp({ edition: 'full', flagSecret: TEST_SECRET });
    expect(app.locals.edition).toBe('full');
    expect(app.locals.challenges.only).toBeUndefined();
    const { agent } = await browserOn(app);
    const index = await agent.get('/');
    expect(indexIds(index.text)).toEqual(allChallenges().map((c) => c.id).sort(byId));
    const gk03 = getChallenge('GK-03') as Challenge;
    expect((await agent.get('/c/GK-03')).status).toBe(200);
    expect((await agent.get(`${challengePath(gk03)}?level=acolyte`)).status).toBe(200);
  });

  it('createApp() without an edition reads HVWA_EDITION (tests/support/setup.ts pins full); the option overrides it', async () => {
    expect(process.env.HVWA_EDITION).toBe('full');
    expect(createApp().locals.challenges.all().length).toBe(allChallenges().length);
    vi.stubEnv('HVWA_EDITION', 'lite');
    try {
      expect(createApp().locals.edition).toBe('lite');
      expect(indexIds((await request(createApp()).get('/')).text)).toEqual(LITE);
      expect(createApp({ edition: 'full' }).locals.edition).toBe('full');
      vi.stubEnv('HVWA_EDITION', '');
      expect(createApp().locals.edition).toBe('full'); // blank = unset
      vi.stubEnv('HVWA_EDITION', 'mini');
      expect(() => createApp()).toThrow(/^HVWA_EDITION: /);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env.HVWA_EDITION).toBe('full');
  });

  it('createApp refuses a lite edition whose challenges are not registered (an import-order or rename bug)', async () => {
    vi.resetModules(); // a fresh registry: nothing registered
    try {
      const fresh = await import('../src/app.js');
      expect(() => fresh.createApp({ edition: 'lite' }))
        .toThrow(/lite edition lists GK-01, GK-02, GK-12, RM-05, SC-01, which are not registered/);
      expect(fresh.createApp({ edition: 'full' }).locals.challenges.all()).toEqual([]);
    } finally {
      vi.resetModules();
    }
  });
});
