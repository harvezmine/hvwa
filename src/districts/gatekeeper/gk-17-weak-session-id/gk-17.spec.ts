// src/districts/gatekeeper/gk-17-weak-session-id/gk-17.spec.ts
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Express } from 'express';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK17 } from './challenge.js'; // registers GK-17 before createApp() inside freshSession
import { cookieName, labState } from './model.js';

const LAB = '/d/gatekeeper/weak-session-id';
const ADMIN = 'citadel_admin';

interface Ctx { agent: Agent; level: Level; sid: string }
/** An exploit (or ordinary use) written as a small script against the lab, like a player would. */
type Script = (c: Ctx) => Promise<request.Response>;

/** The app of each session this file started (bare requests need it). */
const apps = new Map<string, Express>();
async function session() {
  const s = await freshSession();
  apps.set(s.sid, s.app);
  return s;
}
const visit = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
/** Open the admin page presenting ONLY this lab cookie (no jar: the player's own cookie is not sent). */
const adminWith = (c: Ctx, token: string) =>
  bare(apps.get(c.sid)!, c.sid, `${cookieName(c.level)}=${token}`).get(`${LAB}/admin?level=${c.level}`);
const tokenOf = (res: request.Response, level: Level): string => setCookieValue(res, cookieName(level)) ?? '';

/** Try each guess at the admin page; the first response that lets us in (not "Admin only"), else the last response. */
async function tryAll(c: Ctx, guesses: string[]): Promise<request.Response> {
  let last: request.Response | undefined;
  for (const g of guesses) {
    last = await adminWith(c, g);
    if (!last.text.includes('Admin only')) return last;
  }
  return last!;
}

// --- The exploits -------------------------------------------------------------------------
// Acolyte: ids are 1, 2, 3 ...: the admin's id sits right next to yours.
const acolyteExploit: Script = async (c) => {
  await visit(c);
  const mine = tokenOf(await login(c), c.level);
  const n = /^\d+$/.test(mine) ? Number(mine) : 1000;
  return tryAll(c, [n - 1, n + 1, n - 2, n + 2, n - 3].map(String));
};

// Templar: md5(username + login epoch), and the "recent activity" panel tells the admin's login epoch.
const templarExploit: Script = async (c) => {
  const page = await visit(c);
  const epoch = /signed in at epoch (\d+)/.exec(page.text)?.[1] ?? String(Math.floor(Date.now() / 1000));
  const guess = createHash('md5').update(`${ADMIN}${epoch}`).digest('hex');
  return tryAll(c, [guess]);
};

// Inquisitor: a 48-bit LCG (java.util.Random constants) showing its top 32 bits. The guest token you get
// on arrival and the one you get at login are two outputs with the admin's in between: recover the
// hidden low 16 bits from the pair, step once, read off the admin's token.
const MASK = (1n << 48n) - 1n;
const step = (s: bigint) => (s * 0x5DEECE66Dn + 0xBn) & MASK;
const hex8 = (s: bigint) => (s >> 16n).toString(16).padStart(8, '0');
function predictBetween(first: string, third: string): string[] {
  const out: string[] = [];
  if (!/^[0-9a-f]{8}$/.test(first) || !/^[0-9a-f]{8}$/.test(third)) return out;
  for (let low = 0n; low < 65536n; low++) {
    const s1 = (BigInt(`0x${first}`) << 16n) | low;
    const s2 = step(s1);
    if (hex8(step(s2)) === third) out.push(hex8(s2));
  }
  return out;
}
const inquisitorExploit: Script = async (c) => {
  const guest = tokenOf(await visit(c), c.level);
  const mine = tokenOf(await login(c), c.level);
  const candidates = predictBetween(guest, mine);
  return tryAll(c, candidates.length > 0 ? candidates : ['deadbeef']);
};

describeExploitMatrix<Script>({
  challenge: GK17,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => { apps.set(sid, app); return script({ agent, level, sid }); },
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Admin only/,
  legit: [
    {
      name: 'own account pilgrim/pilgrim',
      input: async (c) => { await visit(c); return login(c); },
      expect: 'Signed in as pilgrim',
    },
    {
      name: 'pilgrim opens the admin page with their own session',
      input: async (c) => { await visit(c); const mine = tokenOf(await login(c), c.level); return adminWith(c, mine); },
      expect: 'Admin only',
    },
  ],
  malformed: [], // no query, no parser: nothing that can raise a database error
  privileged: {
    name: 'the real admin session',
    input: async (c) => { await visit(c); return adminWith(c, labState(c.sid, c.level).adminToken); },
    expect: /Citadel admin console/,
  },
});

describe('GK-17 token schemes', () => {
  it('acolyte: sequential integers; your guest, the admin, and your login are consecutive', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'acolyte', sid };
    const guest = Number(tokenOf(await visit(c), c.level));
    const mine = Number(tokenOf(await login(c), c.level));
    expect(Number.isInteger(guest)).toBe(true);
    expect(Number(labState(sid, 'acolyte').adminToken)).toBe(guest + 1);
    expect(mine).toBe(guest + 2);
  });

  it('templar: md5(username + login epoch seconds), and the panel publishes the admin\'s login epoch', async () => {
    const { agent, sid } = await session();
    const state = labState(sid, 'templar');
    state.now = () => 1_731_700_123_456;
    const page = await visit({ agent, level: 'templar', sid });
    expect(page.text).toContain('citadel_admin signed in at epoch 1731700123');
    expect(state.adminToken).toBe(createHash('md5').update('citadel_admin1731700123').digest('hex'));
    expect(tokenOf(page, 'templar')).toBe(createHash('md5').update('guest1731700123').digest('hex'));
  });

  it('only templar publishes login times', async () => {
    for (const level of ['acolyte', 'inquisitor', 'divine'] as const) {
      const { agent, sid } = await session();
      const page = await visit({ agent, level, sid });
      expect(page.text, level).not.toMatch(/at epoch \d+/);
      expect(page.text, level).toContain('citadel_admin');
    }
  });

  it('inquisitor: 8 hex characters from a 48-bit LCG; the pair predicts the admin\'s token (and only it)', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const guest = tokenOf(await visit(c), c.level);
    const mine = tokenOf(await login(c), c.level);
    expect(guest).toMatch(/^[0-9a-f]{8}$/);
    expect(mine).toMatch(/^[0-9a-f]{8}$/);
    const candidates = predictBetween(guest, mine);
    expect(candidates).toContain(labState(sid, 'inquisitor').adminToken);
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it('divine: 32 random bytes (64 hex), never repeated', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const seen = new Set<string>([tokenOf(await visit(c), 'divine'), labState(sid, 'divine').adminToken]);
    for (let i = 0; i < 5; i++) seen.add(tokenOf(await login(c), 'divine'));
    expect(seen.size).toBe(7);
    for (const t of seen) expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('divine: consecutive tokens show no counter, hash-of-counter, time-derived or arithmetic relationship', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const tokens = [tokenOf(await visit(c), 'divine'), labState(sid, 'divine').adminToken];
    for (let i = 0; i < 40; i++) tokens.push(tokenOf(await login(c), 'divine'));
    expect(new Set(tokens).size).toBe(tokens.length);

    // Not a hash of a small counter (the shape of sha256(String(++counter)) or md5 of one).
    const guessable = new Set<string>();
    for (let n = 0; n <= 30_000; n++) {
      guessable.add(createHash('sha256').update(String(n)).digest('hex'));
      guessable.add(createHash('md5').update(String(n)).digest('hex').padEnd(64, '0'));
    }
    for (const t of tokens) expect(guessable.has(t), 'a token is a hash of a small counter').toBe(false);

    // Not a hash of username + epoch seconds (the Templar scheme, with a stronger hash).
    const now = Math.floor(Date.now() / 1000);
    for (const user of ['guest', 'citadel_admin', 'pilgrim']) {
      for (let e = now - 300; e <= now + 300; e++) {
        const h = createHash('sha256').update(`${user}${e}`).digest('hex');
        expect(tokens.includes(h), `${user}${e}`).toBe(false);
      }
    }

    // No arithmetic structure: differences between consecutive tokens are all different (a counter or LCG
    // step would repeat), and the tokens share no long prefix.
    const ints = tokens.map((t) => BigInt(`0x${t}`));
    const diffs = ints.slice(1).map((v, i) => v - ints[i]);
    expect(new Set(diffs.map(String)).size).toBe(diffs.length);
    const second = diffs.slice(1).map((d, i) => d - diffs[i]);
    expect(new Set(second.map(String)).size).toBe(second.length);
    for (let a = 0; a < tokens.length; a++) {
      for (let b = a + 1; b < tokens.length; b++) {
        let k = 0;
        while (k < 64 && tokens[a][k] === tokens[b][k]) k++;
        expect(k, 'shared prefix length').toBeLessThanOrEqual(6);
      }
    }
    // About half the bits differ between consecutive tokens.
    const bits = (x: bigint) => x.toString(2).split('1').length - 1;
    const avg = ints.slice(1).reduce((sum, v, i) => sum + bits(v ^ ints[i]), 0) / (ints.length - 1);
    expect(avg).toBeGreaterThan(110);
    expect(avg).toBeLessThan(146);
  });
});

describe('GK-17 sessions', () => {
  it('the admin is signed in from the moment the lab starts, once per player and level', async () => {
    const a = await session();
    const b = await session();
    for (const level of LEVELS) {
      await visit({ agent: a.agent, level, sid: a.sid });
      await visit({ agent: b.agent, level, sid: b.sid });
    }
    // (Templar's md5(name + second) can legitimately coincide for two labs started in the same second.)
    for (const level of ['inquisitor', 'divine'] as const) {
      expect(labState(a.sid, level).adminToken, level).not.toBe(labState(b.sid, level).adminToken);
    }
    for (const level of LEVELS) expect(labState(a.sid, level).adminToken, level).not.toBe('');
    expect(new Set(LEVELS.map((l) => labState(a.sid, l).adminToken)).size).toBe(LEVELS.length);
  });

  it('a real admin token of one player is worthless in another player\'s lab', async () => {
    const a = await session();
    const b = await session();
    await visit({ agent: a.agent, level: 'divine', sid: a.sid });
    await visit({ agent: b.agent, level: 'divine', sid: b.sid });
    const stolen = labState(a.sid, 'divine').adminToken;
    const res = await adminWith({ agent: b.agent, level: 'divine', sid: b.sid }, stolen);
    expect(res.text).toContain('Admin only');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('flag only below Divine: the genuine admin session shows it, Divine never does', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent, sid } = await session();
      await visit({ agent, level, sid });
      const res = await adminWith({ agent, level, sid }, labState(sid, level).adminToken);
      expect(res.text, level).toMatch(FLAG_RE);
    }
    const { agent, sid } = await session();
    await visit({ agent, level: 'divine', sid });
    const res = await adminWith({ agent, level: 'divine', sid }, labState(sid, 'divine').adminToken);
    expect(res.text).toContain('Citadel admin console');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('no cookie, an empty cookie and odd cookies are simply "Admin only", never a 500', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      await visit({ agent, level, sid });
      for (const token of ['', 'null', '__proto__', 'constructor', '%00', 'x'.repeat(5000)]) {
        const res = await adminWith({ agent, level, sid }, token);
        expect(res.status, `${level} ${token.slice(0, 12)}`).toBe(200);
        expect(res.text, level).toContain('Admin only');
      }
      const noCookie = await bare(apps.get(sid)!, sid).get(`${LAB}/admin?level=${level}`);
      expect(noCookie.text, level).toContain('Admin only');
    }
  });

  it('a wrong password does not sign in; the admin cannot be logged into through the form', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      await visit(c);
      for (const creds of [{ username: 'pilgrim', password: 'nope' }, { username: ADMIN, password: 'pilgrim' }, { username: ADMIN, password: '' }]) {
        const res = await agent.post(`${LAB}?level=${level}`).type('form').send(creds);
        expect(res.text, level).toContain('Invalid username or password.');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('GK-17 the lab is not disturbed by probing', () => {
  it('wrong /admin guesses never mint sessions: the tokens still bracket the admin and the panel keeps its line', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const guest = tokenOf(await visit(c), 'inquisitor');
    const before = labState(sid, 'inquisitor').sessions.size;
    for (let i = 0; i < 40; i++) await adminWith(c, `guess${i}`);
    for (let i = 0; i < 10; i++) await bare(apps.get(sid)!, sid).get(`${LAB}/admin?level=inquisitor`);
    expect(labState(sid, 'inquisitor').sessions.size).toBe(before);
    const mine = tokenOf(await login(c), 'inquisitor');
    expect(predictBetween(guest, mine)).toContain(labState(sid, 'inquisitor').adminToken);
    const page = await visit(c);
    expect(page.text).toContain('citadel_admin signed in');
  });

  it('switching levels keeps each level\'s own session: one cookie per level, nothing is overwritten or re-minted', async () => {
    const { agent, sid } = await session();
    const tokens: Record<string, string> = {};
    for (const level of LEVELS) tokens[level] = tokenOf(await visit({ agent, level, sid }), level);
    const sizes = LEVELS.map((l) => labState(sid, l).sessions.size);
    for (let round = 0; round < 3; round++) {
      for (const level of LEVELS) await visit({ agent, level, sid });
    }
    expect(LEVELS.map((l) => labState(sid, l).sessions.size)).toEqual(sizes);
    for (const level of LEVELS) {
      expect(new Set([...Object.values(tokens)]).size).toBe(LEVELS.length);
      const mine = await agent.get(`${LAB}?level=${level}`);
      expect(mine.text, level).toContain(`Your session: <code>${tokens[level]}</code>`);
    }
  });

  it('the admin line survives any amount of other sign-ins (templar depends on it)', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'templar', sid };
    await visit(c);
    for (let i = 0; i < 60; i++) await login(c);
    const page = await visit(c);
    expect(page.text).toMatch(/citadel_admin signed in at epoch \d+/);
    expect(labState(sid, 'templar').activity.length).toBeLessThanOrEqual(20);
    const epoch = /citadel_admin signed in at epoch (\d+)/.exec(page.text)![1];
    const token = createHash('md5').update(`citadel_admin${epoch}`).digest('hex');
    expect((await adminWith(c, token)).text).toMatch(FLAG_RE);
  });

  it('the session cookie is named per level, set on the canonical lab path, HttpOnly, and the page says how to use it', async () => {
    const { agent } = await session();
    const res = await agent.get(`${LAB.toUpperCase()}?level=templar`);
    const line = [res.headers['set-cookie'] ?? []].flat().find((l) => l.startsWith('citadel_sid_templar='));
    expect(line).toBeDefined();
    expect(line).toContain(`Path=${LAB}`);
    expect(line).toMatch(/HttpOnly/i);
    expect(res.text).toContain('citadel_sid_templar');
    expect(res.text).toMatch(/devtools[\s\S]*curl -b/);
  });

  it('Restart lab starts that level over: a new admin session, and the old admin token is dead', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'acolyte', sid };
    await visit(c);
    const oldAdmin = labState(sid, 'acolyte').adminToken;
    const other = labState(sid, 'templar');
    const res = await agent.post(`${LAB}/_reset?level=acolyte`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${LAB}?level=acolyte`);
    expect(labState(sid, 'templar')).toBe(other);
    await visit(c);
    expect(labState(sid, 'acolyte').adminToken).not.toBe(oldAdmin);
    expect((await adminWith(c, oldAdmin)).text).toContain('Admin only');
  });
});

describeLabView({
  challenge: GK17,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => login({ agent, level, sid }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'x' }),
});

describe('GK-17 lab view specifics', () => {
  it('shows the session token and the recent activity, and links the admin page by its absolute path', async () => {
    const { agent } = await session();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.text).toContain(`Your session: <code>${tokenOf(res, 'acolyte')}</code>`);
    expect(res.text).toContain('Recent activity');
    expect(res.text).toContain('citadel_admin signed in');
    expect(res.text).toContain(`href="${LAB}/admin?level=acolyte"`);
  });
});
