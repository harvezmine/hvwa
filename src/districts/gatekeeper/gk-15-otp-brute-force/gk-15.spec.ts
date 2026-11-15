// src/districts/gatekeeper/gk-15-otp-brute-force/gk-15.spec.ts
import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK15 } from './challenge.js'; // registers GK-15 before createApp() inside freshSession
import * as divineLevel from './levels/divine.js';
import { ADMIN_PASSWORD, labState, type LabState } from './model.js';

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

/** The app of each session this file started (bare requests need it). */
const apps = new Map<string, Express>();
async function session() {
  const s = await freshSession();
  apps.set(s.sid, s.app);
  return s;
}

/**
 * Fire one request as the player (cookie jar) or bare: only the session cookie plus a FORGED
 * `otp_attempts=0`, like a client that rewrites the counter cookie instead of sending the one it was given.
 */
async function fire(agent: Agent, level: Level, sid: string, body: Record<string, string>, isBare = false) {
  const url = `${LAB}?level=${level}`;
  if (!isBare) return agent.post(url).type('form').send(body);
  return bare(apps.get(sid)!, sid, 'otp_attempts=0').post(url).type('form').send(body);
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
  send: (agent, level, steps, _url, { sid, app }) => { apps.set(sid, app); return run(agent, level, steps, sid); },
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
    const { agent, sid } = await session();
    const text = (await run(agent, 'acolyte', [LOGIN_ADMIN, ...times(50, WRONG), RIGHT], sid)).text;
    expect(text).toMatch(FLAG_RE);
  });

  it('really can be brute-forced with at most 10000 guesses (counting up)', async () => {
    const { agent, sid } = await session();
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
    const { agent, sid } = await session();
    const text = (await run(agent, 'templar', [LOGIN_ADMIN, ...times(5, WRONG), RIGHT], sid)).text;
    expect(text).toContain('Too many attempts');
    expect(text).not.toMatch(FLAG_RE);
  });

  it('resend resets the counter but keeps the same code', async () => {
    const { agent, sid } = await session();
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
    const { agent, sid } = await session();
    const first = await run(agent, 'inquisitor', [LOGIN_ADMIN, WRONG], sid);
    expect(setCookieValue(first, 'otp_attempts')).toBe('1');
    const res = await run(agent, 'inquisitor', [...times(4, WRONG), RIGHT], sid);
    expect(res.text).toContain('Too many attempts');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('accepts a counter the client rewrites', async () => {
    const { agent, sid } = await session();
    await run(agent, 'inquisitor', [LOGIN_ADMIN, ...times(5, WRONG)], sid);
    const text = (await fire(agent, 'inquisitor', sid, { step: 'verify', code: labState(sid, 'inquisitor').otp }, true)).text;
    expect(text).toMatch(FLAG_RE);
  });

  it('resend rotates the code and does not touch the counter', async () => {
    const { agent, sid } = await session();
    await run(agent, 'inquisitor', [LOGIN_ADMIN, ...times(3, WRONG)], sid);
    const before = labState(sid, 'inquisitor').otp;
    await step(agent, 'inquisitor', sid, RESEND);
    expect(labState(sid, 'inquisitor').otp).not.toBe(before);
    expect((await run(agent, 'inquisitor', [WRONG, WRONG, RIGHT], sid)).text).toContain('Too many attempts');
  });
});

describe('GK-15 divine', () => {
  it('counts failures on the server: cookies and resends change nothing, the lock sticks', async () => {
    const { agent, sid } = await session();
    // Two of the guesses and the final one forge otp_attempts=0 (a client-side reset): the server does not care.
    const steps: Step[] = [LOGIN_ADMIN, WRONG, WRONG, RESEND, WRONG, { do: 'wrong', bare: true }, RESEND, WRONG, { do: 'right', bare: true }];
    const text = (await run(agent, 'divine', steps, sid)).text;
    expect(text).toContain('Too many attempts');
    expect(text).not.toMatch(FLAG_RE);
  });

  it('resend rotates the code and the old one dies', async () => {
    const { agent, sid } = await session();
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
    const { agent, sid } = await session();
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
    const { agent, sid } = await session();
    const state = labState(sid, 'divine');
    let t = 2_000_000;
    state.now = () => t;
    await step(agent, 'divine', sid, LOGIN_ADMIN);
    const code = state.otp;
    t += 5 * 60_000 + 1;
    expect((await fire(agent, 'divine', sid, { step: 'verify', code })).text).toContain('Code expired');
    await step(agent, 'divine', sid, RESEND);
    expect((await step(agent, 'divine', sid, RIGHT)).text).toContain('Welcome, citadel_admin');
  });

  it('Divine\'s own verify() makes a code single-use: after a success the same code is wrong', () => {
    let t = 1_000;
    const state: LabState = { otp: '1234', issuedAt: t, pending: 'citadel_admin', resends: 0, counters: new Map(), now: () => t };
    expect(divineLevel.verify(state, '1234', {})).toMatchObject({ ok: true });
    t += 1;
    const again = divineLevel.verify(state, '1234', {});
    expect(again.ok).toBe(false);
    expect(divineLevel.verify(state, '', {}).ok).toBe(false); // the cleared code never matches an empty submission
  });

  it('limits resends per sign-in', async () => {
    const { agent, sid } = await session();
    await step(agent, 'divine', sid, LOGIN_ADMIN);
    for (let i = 0; i < 3; i++) expect((await step(agent, 'divine', sid, RESEND)).text).not.toContain('Too many');
    expect((await step(agent, 'divine', sid, RESEND)).text).toContain('Too many');
  });
});

describe('GK-15 flow and per-player state', () => {
  it('verifying or resending before signing in is refused at every level', async () => {
    for (const level of LEVELS) {
      const { agent, sid } = await session();
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
    const { agent, sid } = await session();
    const res = await fire(agent, 'acolyte', sid, { step: 'login', username: 'citadel_admin', password: 'nope' });
    expect(res.text).toContain('Invalid username or password.');
    expect(labState(sid, 'acolyte').pending).toBeNull();
  });

  it('one player\'s lockout never touches another player', async () => {
    const a = await session();
    const b = await session();
    await run(a.agent, 'templar', [LOGIN_ADMIN, ...times(8, WRONG)], a.sid);
    expect((await run(b.agent, 'templar', [LOGIN_ADMIN, RIGHT], b.sid)).text).toMatch(FLAG_RE);
  });

  it('a code from one level or session is not valid in another', async () => {
    const { agent, sid } = await session();
    await step(agent, 'acolyte', sid, LOGIN_ADMIN);
    await step(agent, 'templar', sid, LOGIN_ADMIN);
    const other = await session();
    await step(other.agent, 'acolyte', other.sid, LOGIN_ADMIN);
    // Re-issue until the three codes differ (a 4-digit code can collide by chance), then use the acolyte one elsewhere.
    for (let i = 0; i < 40 && new Set([
      labState(sid, 'acolyte').otp, labState(sid, 'templar').otp, labState(other.sid, 'acolyte').otp]).size < 3; i++) {
      await step(agent, 'templar', sid, LOGIN_ADMIN);
      await step(other.agent, 'acolyte', other.sid, LOGIN_ADMIN);
    }
    const a = labState(sid, 'acolyte').otp;
    expect(new Set([a, labState(sid, 'templar').otp, labState(other.sid, 'acolyte').otp]).size).toBe(3);
    expect((await fire(agent, 'templar', sid, { step: 'verify', code: a })).text).not.toMatch(FLAG_RE);
    expect((await fire(other.agent, 'acolyte', other.sid, { step: 'verify', code: a })).text).not.toMatch(FLAG_RE);
  });

  it('codes are four digits, random per sign-in', async () => {
    const { agent, sid } = await session();
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

describe('GK-15 re-sign-in does not hand the budget back', () => {
  // Five wrong codes, then sign in again and try the right one: must be blocked at every level with a limit.
  const RESIGN: Scenario = [LOGIN_ADMIN, ...times(5, WRONG), LOGIN_ADMIN, RIGHT];

  it.each(['templar', 'inquisitor', 'divine'] as const)('%s still refuses after signing in again', async (level) => {
    const { agent, sid } = await session();
    const res = await run(agent, level, RESIGN, sid);
    expect(res.text).toContain('Too many attempts');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('inquisitor only starts the cookie counter when the client has none', async () => {
    const { agent, sid } = await session();
    const first = await step(agent, 'inquisitor', sid, LOGIN_ADMIN);
    expect(setCookieValue(first, 'otp_attempts')).toBe('0');
    await run(agent, 'inquisitor', times(3, WRONG), sid);
    const again = await step(agent, 'inquisitor', sid, LOGIN_ADMIN);
    expect(setCookieValue(again, 'otp_attempts')).toBeUndefined(); // the count the client holds is left alone
  });

  it('templar: only resend clears the counter', async () => {
    const { agent, sid } = await session();
    await run(agent, 'templar', [LOGIN_ADMIN, ...times(5, WRONG), LOGIN_ADMIN], sid);
    expect((await step(agent, 'templar', sid, RIGHT)).text).toContain('Too many attempts');
    await step(agent, 'templar', sid, RESEND);
    expect((await step(agent, 'templar', sid, RIGHT)).text).toMatch(FLAG_RE);
  });
});

describe('GK-15 restart', () => {
  it('Restart lab forgets the lock and the code at that level only', async () => {
    const { agent, sid } = await session();
    await run(agent, 'templar', [LOGIN_ADMIN, ...times(6, WRONG)], sid);
    await step(agent, 'acolyte', sid, LOGIN_ADMIN);
    const acolyteCode = labState(sid, 'acolyte').otp;
    const res = await agent.post(`${LAB}/_reset?level=templar`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${LAB}?level=templar`);
    expect(labState(sid, 'templar').pending).toBeNull();
    expect((await run(agent, 'templar', [LOGIN_ADMIN, RIGHT], sid)).text).toMatch(FLAG_RE);
    expect(labState(sid, 'acolyte').otp).toBe(acolyteCode);
  });
});

describeLabView({
  challenge: GK15,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { step: 'login' },
  oddBodies: [{ step: { toString: 1 }, code: ['1'] }, { step: 'verify', code: { a: 1 } }, [1, 2], {}],
  ok: async (agent, level, sid) => step(agent, level, sid, LOGIN_PILGRIM),
  bad: async (agent, level, sid) => { await step(agent, level, sid, LOGIN_PILGRIM); return step(agent, level, sid, WRONG); },
});

describe('GK-15 lab view specifics', () => {
  it('shows the phished admin password and the target', async () => {
    const { agent } = await session();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.text).toContain(ADMIN_PASSWORD);
    expect(res.text).toContain('citadel_admin');
  });

  it('after the password step shows the code form; the player\'s own code appears in their inbox, the admin\'s does not', async () => {
    const { agent, sid } = await session();
    const mine = (await step(agent, 'acolyte', sid, LOGIN_PILGRIM)).text;
    expect(mine).toContain('name="code"');
    expect(mine).toContain(`Your code is ${labState(sid, 'acolyte').otp}`);
    const theirs = (await step(agent, 'acolyte', sid, LOGIN_ADMIN)).text;
    expect(theirs).toContain('name="code"');
    expect(theirs).not.toContain(`Your code is ${labState(sid, 'acolyte').otp}`);
  });

  it('the Inquisitor counter cookie is set on the canonical lab path even for an upper-case URL', async () => {
    const { agent, sid } = await session();
    const res = await agent.post(`${LAB.toUpperCase()}?level=inquisitor`).type('form')
      .send({ step: 'login', username: 'citadel_admin', password: ADMIN_PASSWORD });
    void sid;
    const line = [res.headers['set-cookie'] ?? []].flat().find((l) => l.startsWith('otp_attempts='));
    expect(line).toContain(`Path=${LAB}`);
  });
});
