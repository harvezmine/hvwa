// src/districts/gatekeeper/gk-04-jwt-alg-none/gk-04.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieHeader, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeJwtLabBasics } from '../_shared/jwt-lab-basics.spec.js';
import { buildToken, hmacSignature, parseToken, signHmac } from '../_shared/jwt.js';
import { GK04 } from './challenge.js'; // registers GK-04 before createApp() inside freshSession
import { cookieName, labState, mintToken } from './model.js';

const LAB = '/d/gatekeeper/jwt-alg-none';
const ADMIN_CLAIMS = { sub: 'citadel_admin', role: 'admin' };

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const session = () => freshSession();
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const vaultWith = (c: Ctx, token: string) =>
  c.agent.get(`${LAB}/vault?level=${c.level}`).set('Authorization', `Bearer ${token}`);
const tokenOf = (res: request.Response, level: Level) => setCookieValue(res, cookieName(level)) ?? '';

// --- The exploits: forge an admin token that carries no valid signature ---------------------
const acolyteExploit: Script = (c) => vaultWith(c, buildToken({ alg: 'none', typ: 'JWT' }, ADMIN_CLAIMS));
const templarExploit: Script = (c) => vaultWith(c, buildToken({ alg: 'NONE', typ: 'JWT' }, ADMIN_CLAIMS));
const inquisitorExploit: Script = (c) => vaultWith(c, buildToken({ alg: 'HS256', typ: 'JWT' }, ADMIN_CLAIMS));

describeExploitMatrix<Script>({
  challenge: GK04,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Invalid token/,
  legit: [
    {
      name: 'own account pilgrim/pilgrim',
      input: async (c) => login(c),
      expect: 'Signed in as pilgrim',
    },
    {
      name: 'pilgrim opens the vault with their own token',
      input: async (c) => vaultWith(c, tokenOf(await login(c), c.level)),
      expect: /Welcome, pilgrim \(role: user\)/,
    },
  ],
  malformed: [], // no query, no parser errors shown: nothing that can raise a database error
  privileged: {
    name: 'the real admin token',
    input: async (c) => vaultWith(c, mintToken(c.sid, c.level, ADMIN_CLAIMS)),
    expect: /Welcome, citadel_admin \(role: admin\)/,
  },
});

describe('GK-04 token handling', () => {
  it('sign-in issues an HS256 token for pilgrim as a lab cookie (per level, canonical path) and shows it on the page', async () => {
    const { agent } = await session();
    for (const level of LEVELS) {
      const res = await login({ agent, level, sid: '' });
      const token = tokenOf(res, level);
      const p = parseToken(token);
      expect(p.header, level).toMatchObject({ alg: 'HS256', typ: 'JWT' });
      expect(p.payload, level).toMatchObject({ sub: 'pilgrim', role: 'user' });
      expect(res.text, level).toContain(`<code>${token}</code>`);
      const line = setCookieHeader(res, cookieName(level))!;
      expect(line).toContain(`Path=${LAB}`);
      expect(line).not.toMatch(/HttpOnly/i); // deliberately editable: the page says so
      expect(res.text).toMatch(/devtools[\s\S]*Authorization: Bearer/);
    }
  });

  it('flag only for a VERIFIED role "admin": a user token never gets one, a forged role needs a forged signature', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent, sid } = await session();
      const c: Ctx = { agent, level, sid };
      expect((await vaultWith(c, mintToken(sid, level, ADMIN_CLAIMS))).text, level).toMatch(FLAG_RE);
      expect((await vaultWith(c, mintToken(sid, level, { sub: 'pilgrim', role: 'user' }))).text, level).not.toMatch(FLAG_RE);
      expect((await vaultWith(c, mintToken(sid, level, { sub: 'citadel_admin', role: 'Admin' }))).text, level).not.toMatch(FLAG_RE);
      // pilgrim's genuine token with the payload swapped for an admin one and the old signature kept
      const mine = parseToken(tokenOf(await login(c), level));
      const swapped = `${mine.signingInput.split('.')[0]}.${buildToken({}, ADMIN_CLAIMS).split('.')[1]}.${mine.signature}`;
      const res = await vaultWith(c, swapped);
      expect(res.text, level).not.toMatch(FLAG_RE);
      expect(res.text, level).toContain('Invalid token');
    }
  });

  it('a missing, empty or odd token is a plain denial, never a 500 or a flag', async () => {
    const { agent, sid, app } = await session();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const none = await bare(app, sid).get(`${LAB}/vault?level=${level}`);
      expect(none.status, level).toBe(200);
      expect(none.text, level).toContain('Missing token');
      for (const t of ['', 'x', 'a.b', 'a.b.c', '..', '...', 'null', '__proto__.__proto__.__proto__', 'x'.repeat(9000),
        buildToken({}, {}), buildToken({ alg: 1 }, {}), buildToken({ alg: ['none'] }, ADMIN_CLAIMS),
        buildToken({ alg: { toString: 1 } }, ADMIN_CLAIMS), buildToken({ alg: 'HS256' }, { role: ['admin'] })]) {
        const res = await vaultWith(c, t);
        expect(res.status, `${level} ${t.slice(0, 12)}`).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
      const odd = await agent.get(`${LAB}/vault?level=${level}`).set('Authorization', 'Basic abc');
      expect(odd.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('the key belongs to one player and one level: an admin token minted in one lab is worthless in another', async () => {
    const a = await session();
    const b = await session();
    const stolen = mintToken(a.sid, 'acolyte', ADMIN_CLAIMS);
    expect((await vaultWith({ agent: a.agent, level: 'acolyte', sid: a.sid }, stolen)).text).toMatch(FLAG_RE);
    expect((await vaultWith({ agent: b.agent, level: 'acolyte', sid: b.sid }, stolen)).text).not.toMatch(FLAG_RE);
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const res = await vaultWith({ agent: a.agent, level, sid: a.sid }, stolen);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
    const secrets = new Set(LEVELS.map((l) => labState(a.sid, l).secret));
    expect(secrets.size).toBe(LEVELS.length);
    for (const l of LEVELS) expect(labState(a.sid, l).secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GK-04 level behaviour', () => {
  const secretOf = (c: Ctx) => labState(c.sid, c.level).secret;

  it('acolyte: honours alg none, but still checks an HS256 signature', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'acolyte', sid };
    expect((await vaultWith(c, buildToken({ alg: 'none' }, ADMIN_CLAIMS, 'anything'))).text).toMatch(FLAG_RE);
    expect((await vaultWith(c, signHmac('HS256', secretOf(c), ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
    expect((await vaultWith(c, signHmac('HS256', 'wrong', ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
    expect((await vaultWith(c, buildToken({ alg: 'HS256' }, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
  });

  it('templar: rejects exactly "none" but any other case of it skips the signature', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'templar', sid };
    expect((await vaultWith(c, buildToken({ alg: 'none' }, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
    for (const alg of ['NONE', 'None', 'nOnE']) {
      expect((await vaultWith(c, buildToken({ alg }, ADMIN_CLAIMS))).text, alg).toMatch(FLAG_RE);
    }
    expect((await vaultWith(c, buildToken({ alg: 'HS256' }, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
    expect((await vaultWith(c, signHmac('HS256', secretOf(c), ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
  });

  it('inquisitor: every spelling of none is refused; an HS256 token with an EMPTY signature is not checked', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    for (const alg of ['none', 'NONE', 'None', 'nOnE']) {
      expect((await vaultWith(c, buildToken({ alg }, ADMIN_CLAIMS))).text, alg).not.toMatch(FLAG_RE);
      expect((await vaultWith(c, buildToken({ alg }, ADMIN_CLAIMS, 'x'))).text, alg).not.toMatch(FLAG_RE);
    }
    expect((await vaultWith(c, buildToken({ alg: 'HS256' }, ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
    // an empty signature only waives the check for HS256: other algorithms are refused
    for (const alg of ['HS384', 'HS512', 'RS256']) {
      const res = await vaultWith(c, buildToken({ alg }, ADMIN_CLAIMS));
      expect(res.text, alg).not.toMatch(FLAG_RE);
      expect(res.text, alg).toContain('Invalid token');
    }
    // a non-empty wrong signature is refused, and the right one is accepted
    expect((await vaultWith(c, buildToken({ alg: 'HS256' }, ADMIN_CLAIMS, 'AAAA'))).text).not.toMatch(FLAG_RE);
    expect((await vaultWith(c, signHmac('HS256', secretOf(c), ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
    // other algorithms are refused outright
    expect((await vaultWith(c, buildToken({ alg: 'HS512' }, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
  });

  it('divine: algorithm pinned to HS256, signature required and compared in constant time; only the genuine key works', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const input = (alg: string) => buildToken({ alg, typ: 'JWT' }, ADMIN_CLAIMS).slice(0, -1);
    for (const alg of ['none', 'NONE', 'None', '', 'HS384', 'HS512', 'RS256', 'hs256']) {
      for (const sig of ['', hmacSignature('HS256', secretOf(c), input(alg)), 'AAAA']) {
        const res = await vaultWith(c, `${input(alg)}.${sig}`);
        expect(res.text, `${alg} ${sig.slice(0, 4)}`).not.toMatch(FLAG_RE);
        expect(res.text).toContain('Invalid token');
      }
    }
    expect((await vaultWith(c, signHmac('HS256', 'wrong', ADMIN_CLAIMS))).text).toContain('Invalid token');
    const real = await vaultWith(c, signHmac('HS256', secretOf(c), ADMIN_CLAIMS));
    expect(real.text).toContain('Welcome, citadel_admin (role: admin)');
    expect(real.text).not.toMatch(FLAG_RE);
  });

});

describeLabView({
  challenge: GK04,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => login({ agent, level, sid }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'x' }),
});

describeJwtLabBasics({ challenge: GK04, path: LAB, mint: mintToken });
