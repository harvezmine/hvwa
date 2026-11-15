// src/districts/gatekeeper/gk-03-rate-limit-bypass/gk-03.spec.ts
import { describe, it, expect } from 'vitest';
import { freshSession, describeExploitMatrix, describeLabView, runWarmupThenFinal, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK03 } from './challenge.js'; // registers GK-03 before createApp() inside freshSession
import { adminPassword, labState, leakedList, record } from './model.js';

const LAB = '/d/gatekeeper/rate-limit-bypass';
const ADMIN = 'citadel_admin';
const REAL = '@ADMIN'; // replaced by the session's real admin password
interface Creds { username: string; password: string }
/** One request: a form login (`creds`) or a JSON array of pairs (`batch`), with optional headers. */
interface Req { headers?: Record<string, string>; creds?: Creds; batch?: readonly Creds[] }
/** Warm-up requests (answers ignored), then the final request the matrix inspects. */
interface Scenario { warmup: readonly Req[]; final: Req }

const wrong = (n: number, username = ADMIN): Creds => ({ username, password: `not-leaked-${n}` });
const wrongBatch = (count: number, from = 0): Creds[] => Array.from({ length: count }, (_, i) => wrong(from + i));
const PILGRIM: Creds = { username: 'pilgrim', password: 'pilgrim' };
const FINAL_CREDS: Creds = { username: ADMIN, password: REAL };

async function send(agent: Agent, level: Level, req: Req, sid: string) {
  const real = (c: Creds): Creds => (c.password === REAL ? { ...c, password: adminPassword(sid, level) } : c);
  let r = agent.post(`${LAB}?level=${level}`);
  for (const [k, v] of Object.entries(req.headers ?? {})) r = r.set(k, v);
  if (req.batch) return r.send(req.batch.map(real));
  return r.type('form').send(real(req.creds ?? { username: '', password: '' }));
}
const run = (agent: Agent, level: Level, s: Scenario, sid: string) =>
  runWarmupThenFinal(s, (r) => send(agent, level, r, sid));
/** Seven wrong admin guesses, each claiming a different client through `header`, then the real password from yet another. */
const spoofed = (header: string): Scenario => ({
  warmup: Array.from({ length: 7 }, (_, i) => ({ headers: { [header]: `203.0.113.${i + 1}` }, creds: wrong(i) })),
  final: { headers: { [header]: '203.0.113.200' }, creds: FINAL_CREDS },
});

describeExploitMatrix<Scenario>({
  challenge: GK03,
  path: LAB,
  send: (agent, level, s, _url, { sid }) => run(agent, level, s, sid),
  exploits: {
    acolyte: spoofed('X-Forwarded-For'),
    templar: spoofed('X-Real-IP'),
    // Three requests only; the last one carries 30 guesses with the real password among them.
    inquisitor: {
      warmup: [{ batch: wrongBatch(30) }, { batch: wrongBatch(30, 30) }],
      final: { batch: [...wrongBatch(30, 60), FINAL_CREDS] },
    },
  },
  resisted: { acolyte: /Too many attempts/, templar: /Too many attempts/, inquisitor: /Batch requests are not accepted/ },
  legit: [
    { name: 'own account pilgrim/pilgrim', input: { warmup: [], final: { creds: PILGRIM } }, expect: 'Welcome, pilgrim' },
    {
      name: 'wrong admin password',
      input: { warmup: [], final: { creds: { username: ADMIN, password: 'definitely-wrong' } } },
      expect: 'Invalid username or password.',
    },
  ],
  malformed: [], // no query, no parser: nothing that can raise a database error
  privileged: {
    name: 'citadel_admin with the real password',
    input: { warmup: [], final: { creds: FINAL_CREDS } },
    expect: /Welcome, citadel_admin/,
  },
});

describe('GK-03 leaked list', () => {
  it('is served by the lab and holds every level\'s admin password', async () => {
    const { agent, sid } = await freshSession();
    const res = await agent.get(`${LAB}/leaked.txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text.split(/\r?\n/).filter(Boolean)).toEqual(leakedList());
    for (const level of LEVELS) expect(leakedList(), level).toContain(adminPassword(sid, level));
  });

  it('walking it with a fresh X-Forwarded-For per guess solves Acolyte for real', async () => {
    const { agent, sid } = await freshSession();
    let found: string | undefined;
    for (const [i, candidate] of leakedList().entries()) {
      const text = (await agent.post(`${LAB}?level=acolyte`).set('X-Forwarded-For', `198.51.100.${i}`).type('form')
        .send({ username: ADMIN, password: candidate })).text;
      if (FLAG_RE.test(text)) { found = candidate; break; }
    }
    expect(found).toBe(adminPassword(sid, 'acolyte'));
  });
});

describe('GK-03 the limiter', () => {
  it('limits a client to 5 attempts per 15 minutes at acolyte, templar and inquisitor (even the right password)', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      for (let i = 0; i < 5; i++) await send(agent, level, { creds: wrong(i) }, sid);
      const text = (await send(agent, level, { creds: FINAL_CREDS }, sid)).text;
      expect(text, level).toContain('Too many attempts');
      expect(text, level).not.toMatch(FLAG_RE);
    }
  });

  it('acolyte trusts X-Forwarded-For verbatim: a repeated value shares one bucket, a new value a new one', async () => {
    const { agent, sid } = await freshSession();
    const h = { 'X-Forwarded-For': '192.0.2.1' };
    for (let i = 0; i < 5; i++) await send(agent, 'acolyte', { headers: h, creds: wrong(i) }, sid);
    expect((await send(agent, 'acolyte', { headers: h, creds: FINAL_CREDS }, sid)).text).toContain('Too many attempts');
    expect((await send(agent, 'acolyte', { headers: { 'X-Forwarded-For': '192.0.2.2' }, creds: FINAL_CREDS }, sid)).text).toMatch(FLAG_RE);
  });

  it('templar ignores X-Forwarded-For but trusts X-Real-IP', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 5; i++) await send(agent, 'templar', { headers: { 'X-Forwarded-For': `192.0.2.${i}` }, creds: wrong(i) }, sid);
    expect((await send(agent, 'templar', { headers: { 'X-Forwarded-For': '192.0.2.99' }, creds: FINAL_CREDS }, sid)).text).toContain('Too many attempts');
    expect((await send(agent, 'templar', { headers: { 'X-Real-IP': '192.0.2.99' }, creds: FINAL_CREDS }, sid)).text).toMatch(FLAG_RE);
  });

  it('inquisitor keys on the socket address; a batch counts as one attempt but is capped at 50 pairs', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 5; i++) await send(agent, 'inquisitor', { headers: { 'X-Real-IP': `192.0.2.${i}`, 'X-Forwarded-For': `192.0.2.${i}` }, creds: wrong(i) }, sid);
    expect((await send(agent, 'inquisitor', { headers: { 'X-Real-IP': '192.0.2.99' }, creds: FINAL_CREDS }, sid)).text).toContain('Too many attempts');
    const other = await freshSession();
    const oversized = (await send(other.agent, 'inquisitor', { batch: [...wrongBatch(60), FINAL_CREDS] }, other.sid)).text;
    expect(oversized).not.toMatch(FLAG_RE);
    expect(oversized).toContain('Invalid username or password.');
  });

  it('the 15-minute window expires at acolyte, templar and inquisitor (injectable clock, no sleeping)', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      const state = labState(sid, level);
      let t = 9_000_000;
      state.now = () => t;
      for (let i = 0; i < 6; i++) await send(agent, level, { creds: wrong(i) }, sid);
      expect((await send(agent, level, { creds: FINAL_CREDS }, sid)).text, level).toContain('Too many attempts');
      t += 14 * 60_000;
      expect((await send(agent, level, { creds: FINAL_CREDS }, sid)).text, `${level} after 14 min`).toContain('Too many attempts');
      t += 2 * 60_000;
      expect((await send(agent, level, { creds: FINAL_CREDS }, sid)).text, `${level} after 16 min`).toContain('Welcome, citadel_admin');
    }
  });

  it('waiting is not the way through: 20 guesses at the lowest level take hours of clock time, not minutes', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'inquisitor');
    let t = 1_000_000;
    const start = t;
    state.now = () => t;
    let guesses = 0;
    while (guesses < 20) {
      const text = (await send(agent, 'inquisitor', { creds: wrong(guesses) }, sid)).text;
      if (text.includes('Too many attempts')) t += 60_000; else guesses += 1;
    }
    expect(t - start).toBeGreaterThanOrEqual(3 * 15 * 60_000);
  });

  it('divine still refuses after the window, and every further failure doubles the lock', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    const t0 = 9_000_000;
    let t = t0;
    state.now = () => t;
    for (let i = 0; i < 7; i++) await send(agent, 'divine', { creds: wrong(i) }, sid); // 5 failures lock it; 2 more are refused
    expect((await send(agent, 'divine', { creds: FINAL_CREDS }, sid)).text).toContain('Too many attempts');
    t += 16 * 60_000; // the lower levels' window is over ...
    const afterWindow = (await send(agent, 'divine', { creds: FINAL_CREDS }, sid)).text;
    expect(afterWindow).toContain('Too many attempts'); // ... Divine's account lock is not
    expect(afterWindow).not.toMatch(FLAG_RE);
    const firstLock = state.counters.get(ADMIN)!.lockedUntil - t0;
    t = state.counters.get(ADMIN)!.lockedUntil + 1; // the first lock has run: one free try, which fails and doubles the lock
    const t1 = t;
    await send(agent, 'divine', { creds: wrong(99) }, sid);
    const secondLock = state.counters.get(ADMIN)!.lockedUntil - t1;
    expect(secondLock).toBe(firstLock * 2);
    t += firstLock + 1000; // longer than the first lock, shorter than the second
    expect((await send(agent, 'divine', { creds: FINAL_CREDS }, sid)).text, 'still inside the doubled lock').toContain('Too many attempts');
    t = t1 + secondLock + 1;
    expect((await send(agent, 'divine', { creds: FINAL_CREDS }, sid)).text).toContain('Welcome, citadel_admin');
  });

  it('divine: the account limit holds whatever headers claim', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 5; i++) {
      await send(agent, 'divine', { headers: { 'X-Forwarded-For': `1.1.1.${i}`, 'X-Real-IP': `2.2.2.${i}` }, creds: wrong(i) }, sid);
    }
    const mixed = (await send(agent, 'divine', { headers: { 'X-Forwarded-For': '9.9.9.9' }, creds: { username: 'CITADEL_ADMIN ', password: REAL } }, sid)).text;
    expect(mixed).toContain('Too many attempts');
    expect(mixed).not.toMatch(FLAG_RE);
    // Another account is not locked by the admin failures.
    expect((await send(agent, 'divine', { creds: PILGRIM }, sid)).text).toContain('Welcome, pilgrim');
  });

  it('divine: one socket cannot spray many accounts, however X-Forwarded-For and X-Real-IP change on every request', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 20; i++) {
      await send(agent, 'divine', { headers: { 'X-Forwarded-For': `10.0.0.${i}`, 'X-Real-IP': `10.1.0.${i}` }, creds: wrong(i, `ghost${i}`) }, sid);
    }
    const res = await send(agent, 'divine', { headers: { 'X-Forwarded-For': '10.9.9.9', 'X-Real-IP': '10.9.9.8' }, creds: PILGRIM }, sid);
    expect(res.text).toContain('Too many attempts');
  });

  it('client-written header values are bounded: a huge one still counts (hashed), and bucket memory is capped', async () => {
    const { agent, sid } = await freshSession();
    const huge = 'x'.repeat(8000);
    for (let i = 0; i < 5; i++) await send(agent, 'acolyte', { headers: { 'X-Forwarded-For': huge }, creds: wrong(i) }, sid);
    expect((await send(agent, 'acolyte', { headers: { 'X-Forwarded-For': huge }, creds: FINAL_CREDS }, sid)).text).toContain('Too many attempts');
    const state = labState(sid, 'acolyte');
    for (const key of state.buckets.keys()) expect(key.length).toBeLessThanOrEqual(66);
    for (let i = 0; i < 2100; i++) record(state, `spoof-${i}`);
    expect(state.buckets.size).toBeLessThanOrEqual(2000);
  });

  it('divine rejects batches outright and a batch attempt still costs nothing it can exploit', async () => {
    const { agent, sid } = await freshSession();
    const text = (await send(agent, 'divine', { batch: [wrong(1), FINAL_CREDS] }, sid)).text;
    expect(text).toContain('Batch requests are not accepted');
    expect(text).not.toMatch(FLAG_RE);
  });
});

describe('GK-03 per-player state', () => {
  it('one player\'s attempts never use up another player\'s budget (same socket address)', async () => {
    const a = await freshSession();
    const b = await freshSession();
    for (let i = 0; i < 8; i++) await send(a.agent, 'templar', { creds: wrong(i) }, a.sid);
    expect((await send(b.agent, 'templar', { creds: FINAL_CREDS }, b.sid)).text).toMatch(FLAG_RE);
  });

  it('levels of one session have separate budgets', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 8; i++) await send(agent, 'acolyte', { creds: wrong(i) }, sid);
    expect((await send(agent, 'templar', { creds: FINAL_CREDS }, sid)).text).toMatch(FLAG_RE);
  });
});

describe('GK-03 no restart', () => {
  it('there is no Restart lab to refill the budget: /_reset is 404, and failures + reset attempts + the real password stay refused', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor', 'divine'] as const) {
      const { agent, sid } = await freshSession();
      for (let i = 0; i < 6; i++) await send(agent, level, { creds: wrong(i) }, sid);
      expect((await agent.post(`${LAB}/_reset?level=${level}`)).status, level).toBe(404);
      const text = (await send(agent, level, { creds: FINAL_CREDS }, sid)).text;
      expect(text, level).toContain('Too many attempts');
      expect(text, level).not.toMatch(FLAG_RE);
      expect((await agent.get(`${LAB}?level=${level}`)).text, level).not.toContain('lab-restart');
    }
  });
});

describeLabView({
  challenge: GK03,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, null, 'x', [], { username: 5 }], []],
  ok: (agent, level, sid) => send(agent, level, { creds: PILGRIM }, sid),
  bad: (agent, level, sid) => send(agent, level, { creds: wrong(1) }, sid),
});

describe('GK-03 lab view specifics', () => {
  it('links the leaked list by its absolute path and names the target', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.text).toContain(`href="${LAB}/leaked.txt"`);
    expect(res.text).toContain('citadel_admin');
  });
});
