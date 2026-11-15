// src/districts/gatekeeper/gk-02-brute-force/gk-02.spec.ts
import { describe, it, expect } from 'vitest';
import { freshSession, describeExploitMatrix, describeLabView, runWarmupThenFinal, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK02 } from './challenge.js'; // registers GK-02 before createApp() inside freshSession
import { adminPassword, labState, wordlist } from './model.js';

const LAB = '/d/gatekeeper/brute-force';
interface Creds { username: string; password: string }
/** A scenario: failed (or resetting) attempts first, then the final submission the matrix inspects. */
interface Scenario { warmup: readonly Creds[]; final: Creds }
const ADMIN = 'citadel_admin';
const REAL = '@ADMIN'; // replaced by the session's real admin password
const wrong = (username: string, n: number): Creds => ({ username, password: `not-in-the-list-${n}` });
const wrongs = (username: string, count: number) => Array.from({ length: count }, (_, i) => wrong(username, i));
const PILGRIM: Creds = { username: 'pilgrim', password: 'pilgrim' };

async function post(agent: Agent, level: Level, creds: Creds, sid: string) {
  const password = creds.password === REAL ? adminPassword(sid, level) : creds.password;
  return agent.post(`${LAB}?level=${level}`).type('form').send({ username: creds.username, password });
}
const run = (agent: Agent, level: Level, s: Scenario, sid: string) =>
  runWarmupThenFinal({ warmup: s.warmup, final: s.final }, (c) => post(agent, level, c, sid));
const FINAL: Creds = { username: ADMIN, password: REAL };

describeExploitMatrix<Scenario>({
  challenge: GK02,
  path: LAB,
  send: (agent, level, s, _url, { sid }) => run(agent, level, s, sid),
  exploits: {
    // No limit at all: any number of failures, then the right password.
    acolyte: { warmup: wrongs(ADMIN, 12), final: FINAL },
    // Lockout after 5 per username, but a successful login (pilgrim) wipes the counters.
    templar: {
      warmup: [...wrongs(ADMIN, 4), PILGRIM, ...wrongs(ADMIN, 4), PILGRIM, ...wrongs(ADMIN, 4), PILGRIM],
      final: FINAL,
    },
    // Counter keyed on the raw username, matching is case-insensitive: every spelling has its own counter.
    inquisitor: {
      warmup: [...wrongs('citadel_admin', 4), ...wrongs('Citadel_admin', 4), ...wrongs('CITADEL_ADMIN', 4)],
      final: { username: 'citadel_Admin', password: REAL },
    },
  },
  resisted: 'Invalid username or password.',
  legit: [
    { name: 'own account pilgrim/pilgrim', input: { warmup: [], final: PILGRIM }, expect: 'Welcome, pilgrim' },
    {
      name: 'wrong admin password',
      input: { warmup: [], final: { username: ADMIN, password: 'definitely-wrong' } },
      expect: /Wrong password for this user\.|Invalid username or password\./,
    },
  ],
  malformed: [], // no query, no parser: nothing that can raise a database error
  privileged: {
    name: 'citadel_admin with the real password',
    input: { warmup: [], final: FINAL },
    expect: /Welcome, citadel_admin/,
  },
});

describe('GK-02 wordlist', () => {
  it('is served by the lab, ~200 entries, as plain text', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/wordlist.txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const lines = res.text.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(190);
    expect(lines.length).toBeLessThanOrEqual(260);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toEqual(wordlist());
  });

  it('every level\'s admin password comes from it, and differs per session eventually', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { sid } = await freshSession();
      for (const level of LEVELS) {
        const pw = adminPassword(sid, level);
        expect(wordlist(), level).toContain(pw);
        seen.add(pw);
      }
    }
    expect(seen.size).toBeGreaterThan(5); // random per (session, level), not one constant
  });

  it('the real password can be found by walking the served list (the Acolyte solve, for real)', async () => {
    const { agent, sid } = await freshSession();
    const target = adminPassword(sid, 'acolyte');
    let found: string | undefined;
    for (const candidate of wordlist()) {
      const text = (await agent.post(`${LAB}?level=acolyte`).type('form').send({ username: ADMIN, password: candidate })).text;
      if (FLAG_RE.test(text)) { found = candidate; break; }
    }
    expect(found).toBe(target);
  });
});

describe('GK-02 acolyte: enumeration', () => {
  it('distinguishes an unknown user from a wrong password', async () => {
    const { agent, sid } = await freshSession();
    const unknown = (await post(agent, 'acolyte', { username: 'nobody', password: 'x' }, sid)).text;
    const bad = (await post(agent, 'acolyte', { username: ADMIN, password: 'x' }, sid)).text;
    expect(unknown).toContain('Unknown user.');
    expect(bad).toContain('Wrong password for this user.');
  });
  it('the other levels answer both with one message', async () => {
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const { agent, sid } = await freshSession();
      const unknown = (await post(agent, level, { username: 'nobody', password: 'x' }, sid)).text;
      const bad = (await post(agent, level, { username: ADMIN, password: 'x' }, sid)).text;
      expect(unknown, level).toContain('Invalid username or password.');
      expect(bad, level).toContain('Invalid username or password.');
    }
  });
});

describe('GK-02 lockouts', () => {
  it('templar locks the username after 5 failures, even for the right password', async () => {
    const { agent, sid } = await freshSession();
    for (const c of wrongs(ADMIN, 5)) await post(agent, 'templar', c, sid);
    const text = (await post(agent, 'templar', FINAL, sid)).text;
    expect(text).toContain('Account locked');
    expect(text).not.toMatch(FLAG_RE);
  });

  it('templar: the lock is per username (pilgrim is unaffected by admin failures)', async () => {
    const { agent, sid } = await freshSession();
    for (const c of wrongs(ADMIN, 5)) await post(agent, 'templar', c, sid);
    expect((await post(agent, 'templar', PILGRIM, sid)).text).toContain('Welcome, pilgrim');
  });

  it('inquisitor: different spellings are counted separately, the same spelling is locked', async () => {
    const { agent, sid } = await freshSession();
    for (const c of wrongs('CITADEL_ADMIN', 5)) await post(agent, 'inquisitor', c, sid);
    expect((await post(agent, 'inquisitor', { username: 'CITADEL_ADMIN', password: REAL }, sid)).text).toContain('Account locked');
    const other = (await post(agent, 'inquisitor', { username: 'Citadel_Admin', password: REAL }, sid)).text;
    expect(other).toMatch(FLAG_RE);
  });

  it('divine: spellings share one counter; a locked answer is the uniform message', async () => {
    const { agent, sid } = await freshSession();
    const spellings = ['citadel_admin', 'CITADEL_ADMIN', 'Citadel_Admin', ' citadel_admin ', 'citadel_admin'];
    for (const [i, u] of spellings.entries()) await post(agent, 'divine', wrong(u, i), sid);
    const locked = (await post(agent, 'divine', FINAL, sid)).text;
    const plain = (await post(agent, 'divine', wrong('nobody', 1), sid)).text;
    expect(locked).toContain('Invalid username or password.');
    expect(locked).not.toMatch(/locked|too many|Welcome/i);
    expect(plain).toContain('Invalid username or password.');
  });

  it('divine: backoff grows with every failure past the threshold, and the lock expires', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    let t = 1_000_000;
    state.now = () => t;
    for (const c of wrongs(ADMIN, 5)) await post(agent, 'divine', c, sid);
    const first = state.counters.get(ADMIN)!.lockedUntil - t;
    expect(first).toBeGreaterThan(0);
    t = state.counters.get(ADMIN)!.lockedUntil + 1; // wait it out
    await post(agent, 'divine', wrong(ADMIN, 99), sid); // one more failure: a longer lock
    const second = state.counters.get(ADMIN)!.lockedUntil - t;
    expect(second).toBeGreaterThan(first);
    t = state.counters.get(ADMIN)!.lockedUntil + 1;
    expect((await post(agent, 'divine', FINAL, sid)).text).toContain('Welcome, citadel_admin'); // expired lock: real password works
  });

  it('divine locks are stronger than the 15-minute locks below it: 30 minutes first, doubling, capped at a day', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    let t = 4_000_000;
    state.now = () => t;
    for (const c of wrongs(ADMIN, 5)) await post(agent, 'divine', c, sid);
    const first = state.counters.get(ADMIN)!.lockedUntil - t;
    expect(first).toBe(30 * 60_000);
    t += 16 * 60_000; // long enough to beat Templar and Inquisitor
    expect((await post(agent, 'divine', FINAL, sid)).text).not.toMatch(FLAG_RE);
    expect((await post(agent, 'divine', FINAL, sid)).text).toContain('Invalid username or password.');
    for (let i = 0; i < 12; i++) {
      t = state.counters.get(ADMIN)!.lockedUntil + 1;
      await post(agent, 'divine', wrong(ADMIN, 100 + i), sid);
    }
    expect(state.counters.get(ADMIN)!.lockedUntil - t).toBe(24 * 60 * 60_000);
  });

  it('templar and inquisitor locks last 15 minutes, then expire', async () => {
    for (const level of ['templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      const state = labState(sid, level);
      let t = 5_000_000;
      state.now = () => t;
      for (const c of wrongs(ADMIN, 5)) await post(agent, level, c, sid);
      expect((await post(agent, level, FINAL, sid)).text, level).toContain('Account locked');
      t += 14 * 60_000;
      expect((await post(agent, level, FINAL, sid)).text, `${level} still locked after 14 min`).toContain('Account locked');
      t += 2 * 60_000; // 16 minutes in
      expect((await post(agent, level, FINAL, sid)).text, level).toMatch(FLAG_RE);
    }
  });
});

describe('GK-02 per-player state', () => {
  it('one player\'s failures never lock another player out', async () => {
    const a = await freshSession();
    const b = await freshSession();
    for (const c of wrongs(ADMIN, 8)) await post(a.agent, 'divine', c, a.sid);
    const text = (await post(b.agent, 'divine', FINAL, b.sid)).text;
    expect(text).toContain('Welcome, citadel_admin');
  });

  it('a lockout at one level does not touch the other levels of the same session', async () => {
    const { agent, sid } = await freshSession();
    for (const c of wrongs(ADMIN, 8)) await post(agent, 'templar', c, sid);
    expect((await post(agent, 'inquisitor', FINAL, sid)).text).toMatch(FLAG_RE);
  });

  it('a password found at one level does not log in at another (sessions are drawn until the two picks differ)', async () => {
    for (let i = 0; i < 60; i++) {
      const { agent, sid } = await freshSession();
      const found = adminPassword(sid, 'acolyte');
      if (found === adminPassword(sid, 'inquisitor')) continue; // same random pick: try another session
      const text = (await agent.post(`${LAB}?level=inquisitor`).type('form').send({ username: ADMIN, password: found })).text;
      expect(text).not.toMatch(FLAG_RE);
      return;
    }
    throw new Error('60 sessions in a row picked the same password at two levels: the pick is not random');
  });

  it('there is no Restart lab to refill the budget: /_reset is 404, and failures + reset attempts + the real password stay refused', async () => {
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const { agent, sid } = await freshSession();
      for (const c of wrongs(ADMIN, 5)) await post(agent, level, c, sid);
      const res = await agent.post(`${LAB}/_reset?level=${level}`);
      expect(res.status, level).toBe(404);
      const text = (await post(agent, level, FINAL, sid)).text;
      expect(text, level).not.toMatch(FLAG_RE);
      expect(text, level).toMatch(/locked|Invalid username or password/);
      expect((await agent.get(`${LAB}?level=${level}`)).text, level).not.toContain('lab-restart');
    }
  });

  it('waiting is not the way through: after the first lock the clock must run 15 minutes per 5 guesses', async () => {
    for (const level of ['templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      const state = labState(sid, level);
      let t = 7_000_000;
      const start = t;
      state.now = () => t;
      let guesses = 0;
      while (guesses < 30) { // thirty guesses, waiting out every lock a patient attacker meets
        const text = (await post(agent, level, wrong(ADMIN, guesses), sid)).text;
        if (text.includes('Account locked')) t += 60_000; else guesses += 1;
      }
      expect(t - start, level).toBeGreaterThanOrEqual(5 * 15 * 60_000);
    }
  });

  it('divine still refuses once its first lock has run, and backs off further each time', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    let t = 3_000_000;
    state.now = () => t;
    for (const c of wrongs(ADMIN, 5)) await post(agent, 'divine', c, sid);
    const locks: number[] = [];
    for (let round = 0; round < 6; round++) {
      const until = state.counters.get(ADMIN)!.lockedUntil;
      locks.push(until - t);
      t = until - 1;
      expect((await post(agent, 'divine', FINAL, sid)).text, 'one ms before the lock ends').not.toMatch(FLAG_RE);
      t = until + 1;
      await post(agent, 'divine', wrong(ADMIN, round), sid); // the one free try after a lock fails again
    }
    expect(locks[1]).toBeGreaterThan(locks[0]);
    expect(locks[2]).toBeGreaterThan(locks[1]);
  });
});

describeLabView({
  challenge: GK02,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, null, 'x'], {}],
  ok: (agent, level, sid) => post(agent, level, PILGRIM, sid),
  bad: (agent, level, sid) => post(agent, level, wrong(ADMIN, 1), sid),
});

describe('GK-02 lab view specifics', () => {
  it('links the wordlist by its absolute path and names the target', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.text).toContain(`href="${LAB}/wordlist.txt"`);
    expect(res.text).toContain('citadel_admin');
  });
});
