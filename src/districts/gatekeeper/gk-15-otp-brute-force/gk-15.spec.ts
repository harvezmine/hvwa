// src/districts/gatekeeper/gk-15-otp-brute-force/gk-15.spec.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { freshSession, describeExploitMatrix, FLAG_RE, setCookieValue, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK15 } from './challenge.js'; // registers GK-15 before createApp() inside freshSession
import { ADMIN_PASSWORD, labState } from './model.js';

const LAB = '/d/gatekeeper/otp-brute-force';

/**
 * One request of a scenario. `bare` sends only the session cookie (like curl would), so
 * any other cookie the lab set is not replayed. Codes are resolved at send time:
 * 'wrong' is never the live code, 'right' always is.
 */
type Step =
  | { do: 'login'; as: 'admin' | 'pilgrim' }
  | { do: 'wrong' | 'right' | 'resend'; bare?: boolean };
type Scenario = readonly Step[];

const LOGIN_ADMIN: Step = { do: 'login', as: 'admin' };
const LOGIN_PILGRIM: Step = { do: 'login', as: 'pilgrim' };
const times = (n: number, s: Step): Step[] => Array.from({ length: n }, () => s);
const WRONG: Step = { do: 'wrong' };
const RESEND: Step = { do: 'resend' };
const RIGHT: Step = { do: 'right' };

const wrongOf = (otp: string) => String((Number(otp) + 1) % 10000).padStart(4, '0');

/** The Express app behind a supertest agent (the agent keeps it as `app`). */
const appOf = (agent: Agent) => (agent as unknown as { app: never }).app;

/** Fire one request as the player (cookie jar) or bare (session cookie only). */
async function fire(agent: Agent, level: Level, sid: string, body: Record<string, string>, bare = false) {
  const url = `${LAB}?level=${level}`;
  if (!bare) return agent.post(url).type('form').send(body);
  return request(appOf(agent)).post(url).set('Cookie', `hvwa_sid=${sid}`).type('form').send(body);
}

async function step(agent: Agent, level: Level, sid: string, s: Step) {
  const otp = labState(sid, level).otp;
  switch (s.do) {
    case 'login': return fire(agent, level, sid, { step: 'login', username: s.as === 'admin' ? 'citadel_admin' : 'pilgrim', password: s.as === 'admin' ? ADMIN_PASSWORD : 'pilgrim' });
    case 'wrong': return fire(agent, level, sid, { step: 'verify', code: wrongOf(otp) }, s.bare);
    case 'right': return fire(agent, level, sid, { step: 'verify', code: otp }, s.bare);
    case 'resend': return fire(agent, level, sid, { step: 'resend' }, s.bare);
  }
}

async function run(agent: Agent, level: Level, steps: Scenario, sid: string) {
  let last: Awaited<ReturnType<typeof step>> | undefined;
  for (const s of steps) last = await step(agent, level, sid, s);
  return last!;
}

describeExploitMatrix<Scenario>({
  challenge: GK15,
  path: LAB,
  send: (agent, level, steps, _url, { sid }) => run(agent, level, steps, sid),
  exploits: {
    // No attempt limit: twelve wrong codes, then the right one.
    acolyte: [LOGIN_ADMIN, ...times(12, WRONG), RIGHT],
    // 5-attempt limit, but "resend" zeroes the counter and keeps the code: 4 guesses, resend, repeat.
    templar: [LOGIN_ADMIN, ...[0, 1, 2].flatMap(() => [...times(4, WRONG), RESEND]), RIGHT],
    // The counter lives in a cookie the client controls: just do not send it back.
    inquisitor: [LOGIN_ADMIN, ...times(12, { do: 'wrong', bare: true }), { do: 'right', bare: true }],
  },
  resisted: /Too many attempts/,
  legit: [
    { name: 'own account pilgrim, code from the inbox', input: [LOGIN_PILGRIM, RIGHT], expect: 'Welcome, pilgrim' },
    { name: 'a wrong code', input: [LOGIN_PILGRIM, WRONG], expect: 'Incorrect code.' },
  ],
  malformed: [], // no query, no parser: nothing that can raise a database error
  privileged: {
    name: 'citadel_admin with password and the live code',
    input: [LOGIN_ADMIN, RIGHT],
    expect: /Welcome, citadel_admin/,
  },
});

describe('GK-15 acolyte', () => {
  it('has no attempt limit: fifty wrong codes and the right one still passes', async () => {
    const { agent, sid } = await freshSession();
    const text = (await run(agent, 'acolyte', [LOGIN_ADMIN, ...times(50, WRONG), RIGHT], sid)).text;
    expect(text).toMatch(FLAG_RE);
  });

  it('really can be brute-forced with at most 10000 guesses (counting up)', async () => {
    const { agent, sid } = await freshSession();
    await step(agent, 'acolyte', sid, LOGIN_ADMIN);
    const target = Number(labState(sid, 'acolyte').otp);
    // Walk only a small window around the target: the point is that nothing stops the walk.
    let found = false;
    for (let n = Math.max(0, target - 30); n <= target; n++) {
      const text = (await fire(agent, 'acolyte', sid, { step: 'verify', code: String(n).padStart(4, '0') })).text;
      if (FLAG_RE.test(text)) { found = true; break; }
    }
    expect(found).toBe(true);
  });
});

describe('GK-15 templar', () => {
  it('locks after 5 wrong codes, even for the right one', async () => {
    const { agent, sid } = await freshSession();
    const text = (await run(agent, 'templar', [LOGIN_ADMIN, ...times(5, WRONG), RIGHT], sid)).text;
    expect(text).toContain('Too many attempts');
    expect(text).not.toMatch(FLAG_RE);
  });

  it('resend resets the counter but keeps the same code', async () => {
    const { agent, sid } = await freshSession();
    await run(agent, 'templar', [LOGIN_ADMIN, ...times(5, WRONG)], sid);
    const before = labState(sid, 'templar').otp;
    const resent = (await step(agent, 'templar', sid, RESEND)).text;
    expect(resent).toMatch(/new code/i);
    expect(labState(sid, 'templar').otp).toBe(before);
    expect((await step(agent, 'templar', sid, RIGHT)).text).toMatch(FLAG_RE);
  });
});

describe('GK-15 inquisitor', () => {
  it('keeps its attempt counter in a plain cookie, and locks at 5 for a client that sends it back', async () => {
    const { agent, sid } = await freshSession();
    const first = await run(agent, 'inquisitor', [LOGIN_ADMIN, WRONG], sid);
    expect(setCookieValue(first, 'otp_attempts')).toBe('1');
    const res = await run(agent, 'inquisitor', [...times(4, WRONG), RIGHT], sid);
    expect(res.text).toContain('Too many attempts');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('accepts a counter the client rewrites', async () => {
    const { agent, sid } = await freshSession();
    await run(agent, 'inquisitor', [LOGIN_ADMIN, ...times(5, WRONG)], sid);
    const text = (await request(appOf(agent)).post(`${LAB}?level=inquisitor`)
      .set('Cookie', `hvwa_sid=${sid}; otp_attempts=0`).type('form')
      .send({ step: 'verify', code: labState(sid, 'inquisitor').otp })).text;
    expect(text).toMatch(FLAG_RE);
  });

  it('resend rotates the code and does not touch the counter', async () => {
    const { agent, sid } = await freshSession();
    await run(agent, 'inquisitor', [LOGIN_ADMIN, ...times(3, WRONG)], sid);
    const before = labState(sid, 'inquisitor').otp;
    await step(agent, 'inquisitor', sid, RESEND);
    expect(labState(sid, 'inquisitor').otp).not.toBe(before);
    expect((await run(agent, 'inquisitor', [WRONG, WRONG, RIGHT], sid)).text).toContain('Too many attempts');
  });
});

describe('GK-15 divine', () => {
  it('counts failures on the server: cookies and resends change nothing, the lock sticks', async () => {
    const { agent, sid } = await freshSession();
    const steps: Step[] = [LOGIN_ADMIN, WRONG, WRONG, RESEND, WRONG, { do: 'wrong', bare: true }, RESEND, WRONG, { do: 'right', bare: true }];
    const text = (await run(agent, 'divine', steps, sid)).text;
    expect(text).toContain('Too many attempts');
    expect(text).not.toMatch(FLAG_RE);
  });

  it('resend rotates the code and the old one dies', async () => {
    const { agent, sid } = await freshSession();
    await step(agent, 'divine', sid, LOGIN_ADMIN);
    const old = labState(sid, 'divine').otp;
    await step(agent, 'divine', sid, RESEND);
    const fresh = labState(sid, 'divine').otp;
    expect(fresh).not.toBe(old);
    const text = (await fire(agent, 'divine', sid, { step: 'verify', code: old })).text;
    expect(text).toContain('Incorrect code.');
    expect((await step(agent, 'divine', sid, RIGHT)).text).toContain('Welcome, citadel_admin');
  });

  it('a lock outlives a fresh sign-in, then expires', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    let t = 1_000_000;
    state.now = () => t;
    await run(agent, 'divine', [LOGIN_ADMIN, ...times(5, WRONG)], sid);
    const relogin = (await step(agent, 'divine', sid, LOGIN_ADMIN)).text;
    expect(relogin).toContain('Too many attempts');
    expect((await step(agent, 'divine', sid, RIGHT)).text).toContain('Too many attempts');
    t += 16 * 60_000;
    const ok = await run(agent, 'divine', [LOGIN_ADMIN, RIGHT], sid);
    expect(ok.text).toContain('Welcome, citadel_admin');
  });

  it('a code expires after 5 minutes and works only once', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    let t = 2_000_000;
    state.now = () => t;
    await step(agent, 'divine', sid, LOGIN_ADMIN);
    const code = state.otp;
    t += 5 * 60_000 + 1;
    expect((await fire(agent, 'divine', sid, { step: 'verify', code })).text).toContain('Code expired');
    await step(agent, 'divine', sid, RESEND);
    expect((await step(agent, 'divine', sid, RIGHT)).text).toContain('Welcome, citadel_admin');
    // Single use: the same code again, after success, opens nothing.
    const again = (await fire(agent, 'divine', sid, { step: 'verify', code: state.otp })).text;
    expect(again).not.toContain('Welcome');
  });

  it('limits resends per sign-in', async () => {
    const { agent, sid } = await freshSession();
    await step(agent, 'divine', sid, LOGIN_ADMIN);
    for (let i = 0; i < 3; i++) expect((await step(agent, 'divine', sid, RESEND)).text).not.toContain('Too many');
    expect((await step(agent, 'divine', sid, RESEND)).text).toContain('Too many');
  });
});

describe('GK-15 flow and per-player state', () => {
  it('verifying or resending before signing in is refused at every level', async () => {
    for (const level of LEVELS) {
      const { agent, sid } = await freshSession();
      const bodies: Record<string, string>[] = [{ step: 'verify', code: '0000' }, { step: 'resend' }];
      for (const body of bodies) {
        const res = await fire(agent, level, sid, body);
        expect(res.status, level).toBe(200);
        expect(res.text, level).toContain('Sign in first.');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('a wrong password never reaches the code step', async () => {
    const { agent, sid } = await freshSession();
    const res = await fire(agent, 'acolyte', sid, { step: 'login', username: 'citadel_admin', password: 'nope' });
    expect(res.text).toContain('Invalid username or password.');
    expect(labState(sid, 'acolyte').pending).toBeNull();
  });

  it('one player\'s lockout never touches another player', async () => {
    const a = await freshSession();
    const b = await freshSession();
    await run(a.agent, 'templar', [LOGIN_ADMIN, ...times(8, WRONG)], a.sid);
    expect((await run(b.agent, 'templar', [LOGIN_ADMIN, RIGHT], b.sid)).text).toMatch(FLAG_RE);
  });

  it('a code from one level or session is not valid in another', async () => {
    const { agent, sid } = await freshSession();
    await step(agent, 'acolyte', sid, LOGIN_ADMIN);
    await step(agent, 'templar', sid, LOGIN_ADMIN);
    const other = await freshSession();
    await step(other.agent, 'acolyte', other.sid, LOGIN_ADMIN);
    const a = labState(sid, 'acolyte').otp;
    const t = labState(sid, 'templar').otp;
    const o = labState(other.sid, 'acolyte').otp;
    if (a !== t) expect((await fire(agent, 'templar', sid, { step: 'verify', code: a })).text).not.toMatch(FLAG_RE);
    if (a !== o) expect((await fire(other.agent, 'acolyte', other.sid, { step: 'verify', code: a })).text).not.toMatch(FLAG_RE);
  });

  it('codes are four digits, random per sign-in', async () => {
    const { agent, sid } = await freshSession();
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await step(agent, 'acolyte', sid, LOGIN_ADMIN);
      const otp = labState(sid, 'acolyte').otp;
      expect(otp).toMatch(/^\d{4}$/);
      seen.add(otp);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe('GK-15 lab view', () => {
  it('shows the phished admin password and a sign-in form that posts back to the lab', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(ADMIN_PASSWORD);
    expect(res.text).toContain('citadel_admin');
    expect(res.text).not.toMatch(/type="password"/);
    for (const form of res.text.matchAll(/<form[^>]*>/g)) expect(form[0]).not.toContain('action');
  });

  it('after the password step shows the code form; the player\'s own code appears in their inbox, the admin\'s does not', async () => {
    const { agent, sid } = await freshSession();
    const mine = (await step(agent, 'acolyte', sid, LOGIN_PILGRIM)).text;
    expect(mine).toContain('name="code"');
    expect(mine).toContain(`Your code is ${labState(sid, 'acolyte').otp}`);
    const theirs = (await step(agent, 'acolyte', sid, LOGIN_ADMIN)).text;
    expect(theirs).toContain('name="code"');
    expect(theirs).not.toContain(`Your code is ${labState(sid, 'acolyte').otp}`);
  });

  it('escapes what the player typed; odd bodies are a failed step, never a 500', async () => {
    const { agent } = await freshSession();
    const res = await agent.post(`${LAB}?level=templar`).type('form')
      .send({ step: 'login', username: '"><script>alert(1)</script>', password: 'x' });
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(res.text).not.toContain('<script>alert(1)');
    for (const level of LEVELS) {
      for (const body of [{ step: { toString: 1 }, code: ['1'] }, { step: 'verify', code: { a: 1 } }, [1, 2], {}]) {
        const r = await agent.post(`${LAB}?level=${level}`).send(body);
        expect(r.status, `${level} ${JSON.stringify(body)}`).toBe(200);
        expect(r.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('marks success and failure messages for styling', async () => {
    const { agent, sid } = await freshSession();
    expect((await step(agent, 'templar', sid, LOGIN_PILGRIM)).text).toMatch(/class="lab-message lab-success"/);
    expect((await step(agent, 'templar', sid, WRONG)).text).toMatch(/class="lab-message lab-error"[^>]*>Incorrect code/);
    expect((await step(agent, 'templar', sid, RIGHT)).text).toMatch(/class="lab-message lab-success"[^>]*>Welcome, pilgrim/);
  });
});
