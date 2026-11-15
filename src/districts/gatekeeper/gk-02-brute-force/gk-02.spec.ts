// src/districts/gatekeeper/gk-02-brute-force/gk-02.spec.ts
import { describe, it, expect } from 'vitest';
import { freshSession, describeExploitMatrix, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
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
async function run(agent: Agent, level: Level, s: Scenario, sid: string) {
  for (const c of s.warmup) await post(agent, level, c, sid);
  return post(agent, level, s.final, sid);
}
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

  it('templar and inquisitor locks expire', async () => {
    for (const level of ['templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      const state = labState(sid, level);
      let t = 5_000_000;
      state.now = () => t;
      for (const c of wrongs(ADMIN, 5)) await post(agent, level, c, sid);
      expect((await post(agent, level, FINAL, sid)).text, level).toContain('Account locked');
      t += 10 * 60_000;
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

  it('a password found at one level does not log in at another unless it happens to be the same pick', async () => {
    const { agent, sid } = await freshSession();
    const text = (await agent.post(`${LAB}?level=inquisitor`).type('form')
      .send({ username: ADMIN, password: adminPassword(sid, 'acolyte') })).text;
    if (adminPassword(sid, 'acolyte') !== adminPassword(sid, 'inquisitor')) expect(text).not.toMatch(FLAG_RE);
  });
});

describe('GK-02 lab view', () => {
  it('tells the player their account, links the wordlist, posts back to the lab', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/);
    expect(res.text).toContain(`href="${LAB}/wordlist.txt"`); // absolute: a relative link would leave the lab
    expect(res.text).toContain('citadel_admin');
    expect(res.text).not.toMatch(/type="password"/);
    expect(/<form[^>]*>/.exec(res.text)?.[0]).not.toContain('action');
  });

  it('keeps the submitted username escaped, and non-string fields are a failed login, not a 500', async () => {
    const { agent } = await freshSession();
    const res = await agent.post(`${LAB}?level=templar`).type('form').send({ username: '"><script>alert(1)</script>', password: 'x' });
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(res.text).not.toContain('<script>alert(1)');
    for (const level of LEVELS) {
      const json = await agent.post(`${LAB}?level=${level}`).send({ username: { toString: 1 }, password: ['a'] });
      expect(json.status, level).toBe(200);
      expect(json.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('marks success and failure messages for styling', async () => {
    const { agent, sid } = await freshSession();
    expect((await post(agent, 'templar', PILGRIM, sid)).text).toMatch(/class="lab-message lab-success"[^>]*>Welcome, pilgrim/);
    expect((await post(agent, 'templar', wrong(ADMIN, 1), sid)).text).toMatch(/class="lab-message lab-error"/);
  });
});
