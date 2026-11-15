// src/districts/gatekeeper/gk-06-jwt-kid-injection/gk-06.spec.ts
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieHeader, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeJwtLabBasics } from '../_shared/jwt-lab.testkit.js';
import { buildToken, parseToken, signHmac } from '../_shared/jwt.js';
import { GK06 } from './challenge.js'; // registers GK-06 before createApp() inside freshSession
import { cookieName, labState, mintToken } from './model.js';

const LAB = '/d/gatekeeper/jwt-kid-injection';
const ADMIN_CLAIMS = { sub: 'citadel_admin', role: 'admin' };

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const session = () => freshSession();
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const vaultWith = (c: Ctx, token: string) =>
  c.agent.get(`${LAB}/vault?level=${c.level}`).set('Authorization', `Bearer ${token}`);
const robots = async (c: Ctx) => (await c.agent.get(`${LAB}/robots.txt?level=${c.level}`)).text;
const tokenOf = (res: request.Response, level: Level) => setCookieValue(res, cookieName(level)) ?? '';
/** An admin token whose `kid` is attacker-chosen and whose HMAC key is whatever the attacker predicts. */
const forged = (kid: unknown, key: string) => signHmac('HS256', key, ADMIN_CLAIMS, { kid });

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: kid is joined onto /keys/ in the simulated file system: ../../dev/null is empty, so the key is "".
const acolyteExploit: Script = (c) => vaultWith(c, forged('../../dev/null', ''));
// Templar: "../" is stripped once, so "....//" turns back into "../". The key is a public file's contents.
const templarExploit: Script = async (c) => vaultWith(c, forged('....//....//srv/www/robots.txt', await robots(c)));
// Inquisitor: kid goes into SQL; a UNION supplies the key the attacker signs with.
const inquisitorExploit: Script = (c) => vaultWith(c, forged("x' UNION SELECT 'attacker-secret", 'attacker-secret'));

describeExploitMatrix<Script>({
  challenge: GK06,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Invalid token/,
  legit: [
    { name: 'own account pilgrim/pilgrim', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    {
      name: 'pilgrim opens the vault with their own token',
      input: async (c) => vaultWith(c, tokenOf(await login(c), c.level)),
      expect: /Welcome, pilgrim \(role: user\)/,
    },
  ],
  malformed: [{ name: 'a lone quote as kid', input: (c) => vaultWith(c, forged("'", 'x')), levels: ['inquisitor'] }],
  privileged: {
    name: 'the real admin token',
    input: async (c) => vaultWith(c, mintToken(c.sid, c.level, ADMIN_CLAIMS)),
    expect: /Welcome, citadel_admin \(role: admin\)/,
  },
});

describe('GK-06 tokens and keys', () => {
  it('sign-in issues an HS256 token naming its key (kid) as a lab cookie (per level, canonical path), shown on the page', async () => {
    const { agent } = await session();
    for (const level of LEVELS) {
      const res = await login({ agent, level, sid: '' });
      const token = tokenOf(res, level);
      const p = parseToken(token);
      expect(p.header, level).toMatchObject({ alg: 'HS256', typ: 'JWT' });
      expect(typeof p.header.kid, level).toBe('string');
      expect(p.payload, level).toMatchObject({ sub: 'pilgrim', role: 'user' });
      expect(res.text, level).toContain(`<code>${token}</code>`);
      const line = setCookieHeader(res, cookieName(level))!;
      expect(line).toContain(`Path=${LAB}`);
      expect(line).not.toMatch(/HttpOnly/i); // deliberately editable: the page says so
      expect(res.text).toMatch(/devtools[\s\S]*Authorization: Bearer/);
    }
  });

  it('the genuine key ids: acolyte/templar name a key FILE, inquisitor/divine a key id', async () => {
    const { agent } = await session();
    const kids: Record<string, string> = {};
    for (const level of LEVELS) kids[level] = String(parseToken(tokenOf(await login({ agent, level, sid: '' }), level)).header.kid);
    expect(kids).toEqual({ acolyte: 'k1.key', templar: 'k1.key', inquisitor: 'k1', divine: 'k1' });
  });

  it('keys are per player and per level; a genuine admin token minted in one lab is worthless in another', async () => {
    const a = await session();
    const b = await session();
    const keys = new Set<string>(LEVELS.map((l) => labState(a.sid, l).signingKey));
    keys.add(labState(b.sid, 'divine').signingKey);
    expect(keys.size).toBe(LEVELS.length + 1);
    for (const l of LEVELS) expect(labState(a.sid, l).signingKey).toMatch(/^[0-9a-f]{64}$/);
    const stolen = mintToken(a.sid, 'acolyte', ADMIN_CLAIMS);
    expect((await vaultWith({ agent: a.agent, level: 'acolyte', sid: a.sid }, stolen)).text).toMatch(FLAG_RE);
    for (const [who, level] of [[b, 'acolyte'], [a, 'templar'], [a, 'inquisitor'], [a, 'divine']] as const) {
      const res = await vaultWith({ agent: who.agent, level, sid: who.sid }, stolen);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('flag only for a VERIFIED role "admin" at every level below Divine', async () => {
    const { agent, sid } = await session();
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const c: Ctx = { agent, level, sid };
      expect((await vaultWith(c, mintToken(sid, level, ADMIN_CLAIMS))).text, level).toMatch(FLAG_RE);
      expect((await vaultWith(c, mintToken(sid, level, { sub: 'pilgrim', role: 'user' }))).text, level).not.toMatch(FLAG_RE);
    }
  });

  it('a missing or odd token or kid is a plain denial, never a 500 or a flag', async () => {
    const { agent, sid, app } = await session();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const none = await bare(app, sid).get(`${LAB}/vault?level=${level}`);
      expect(none.status).toBe(200);
      expect(none.text).toContain('Missing token');
      const key = labState(sid, level).signingKey;
      for (const kid of [undefined, null, 1, true, [], ['k1'], {}, { toString: 1 }, '', ' ', 'x'.repeat(5000), '\u0000', '/', '..', '../..',
        '__proto__', 'constructor', 'k1\u0000.key']) {
        const res = await vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS, kid === undefined ? {} : { kid }));
        expect(res.status, `${level} ${JSON.stringify(kid)?.slice(0, 20)}`).toBe(200);
        expect(res.text, `${level} ${JSON.stringify(kid)?.slice(0, 20)}`).not.toMatch(FLAG_RE);
      }
      for (const t of ['', 'x', 'a.b.c', 'x'.repeat(9000), buildToken({}, {}), buildToken({ alg: 'none', kid: 'k1' }, ADMIN_CLAIMS),
        buildToken({ alg: 'HS256', kid: 'k1' }, ADMIN_CLAIMS), buildToken({ alg: 'HS512', kid: 'k1.key' }, ADMIN_CLAIMS, 'AAAA')]) {
        const res = await vaultWith(c, t);
        expect(res.status, level).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('GK-06 the simulated file system (acolyte, templar)', () => {
  it('holds the genuine key file and a few other files with KNOWN contents; the real disk is never read', async () => {
    const { sid } = await session();
    const files = labState(sid, 'acolyte').files;
    expect(files.get('/keys/k1.key')).toBe(labState(sid, 'acolyte').signingKey);
    expect(files.get('/dev/null')).toBe('');
    expect(files.get('/srv/www/robots.txt')).toContain('User-agent');
    expect(files.has('/etc/passwd')).toBe(false);
    // the level files and the lab never import the real file system
    const dir = new URL('./', import.meta.url);
    for (const rel of ['challenge.ts', 'model.ts', ...readdirSync(new URL('./levels/', dir)).map((f) => `levels/${f}`)]) {
      expect(readFileSync(new URL(rel, dir), 'utf8'), rel).not.toMatch(/from 'node:fs|from 'fs|require\('fs|node:child_process/);
    }
  });

  it('robots.txt is public, plain text, and exactly the simulated /srv/www/robots.txt', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const res = await agent.get(`${LAB}/robots.txt?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/^text\/plain/);
      expect(res.text, level).toBe(labState(sid, level).files.get('/srv/www/robots.txt'));
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.text, level).toContain(`href="${LAB}/robots.txt?level=${level}"`);
      expect(page.text, level).toContain('/srv/www'); // the web root is named, so the robots.txt trail is discoverable
    }
  });

  it('acolyte: kid is joined onto /keys/ and normalized: any simulated file is the key, nothing outside the map is', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'acolyte', sid };
    const st = labState(sid, 'acolyte');
    const ok = [
      ['k1.key', st.signingKey], ['../keys/k1.key', st.signingKey], ['../../dev/null', ''], ['../../../../../../dev/null', ''],
      ['../../srv/www/robots.txt', st.files.get('/srv/www/robots.txt')!], ['../../etc/hostname', st.files.get('/etc/hostname')!],
    ] as const;
    for (const [kid, key] of ok) expect((await vaultWith(c, forged(kid, key))).text, kid).toMatch(FLAG_RE);
    for (const kid of ['k1', '../../etc/passwd', '/dev/null', '..', 'missing.key', '../../dev/null/']) {
      const res = await vaultWith(c, forged(kid, ''));
      expect(res.text, kid).not.toMatch(FLAG_RE);
      expect(res.text, kid).toContain('Invalid token');
    }
    // a wrong key for a right file is a bad signature
    expect((await vaultWith(c, forged('../../dev/null', 'not-empty'))).text).not.toMatch(FLAG_RE);
  });

  it('templar: "../" is removed once; "....//" and "..././" survive that and still traverse; plain "../" does not', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'templar', sid };
    expect((await vaultWith(c, forged('k1.key', labState(sid, 'templar').signingKey))).text).toMatch(FLAG_RE);
    expect((await vaultWith(c, forged('../../dev/null', ''))).text).not.toMatch(FLAG_RE);
    for (const kid of ['....//....//dev/null', '..././..././dev/null', '....//../dev/null']) {
      expect((await vaultWith(c, forged(kid, ''))).text, kid).toMatch(FLAG_RE);
    }
  });
});

describe('GK-06 the key table (inquisitor)', () => {
  it('looks the key up by kid with SQL: the genuine id works, an injected comment still finds the genuine key', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const key = labState(sid, 'inquisitor').signingKey;
    expect((await vaultWith(c, forged('k1', key))).text).toMatch(FLAG_RE);
    expect((await vaultWith(c, forged("k1' --", key))).text).toMatch(FLAG_RE);
    expect((await vaultWith(c, forged('k1', 'wrong'))).text).not.toMatch(FLAG_RE);
    expect((await vaultWith(c, forged('nope', key))).text).not.toMatch(FLAG_RE);
  });

  it('shows the database error below Divine (a lone quote), and the key table survives stacked-query attempts', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const res = await vaultWith(c, forged("'", 'x'));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Database error/);
    for (const kid of ["x'; DELETE FROM keys; --", "x'; DROP TABLE keys; --"]) await vaultWith(c, forged(kid, 'x'));
    expect((await vaultWith(c, forged('k1', labState(sid, 'inquisitor').signingKey))).text).toMatch(FLAG_RE);
  });

  it('a UNION can supply any key: numbers, NULL and other columns do not crash the lab', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    expect((await vaultWith(c, forged("x' UNION SELECT '7", '7'))).text).toMatch(FLAG_RE);
    for (const kid of ["x' UNION SELECT 7 --", "x' UNION SELECT NULL --", "x' UNION SELECT 1,2 --", "x' UNION SELECT x'00' --"]) {
      const res = await vaultWith(c, forged(kid, 'x'));
      expect(res.status, kid).toBe(200);
      expect(res.text, kid).not.toMatch(FLAG_RE);
    }
  });

  it('the key table is per player and per level, and not reachable at the other levels', async () => {
    const a = await session();
    const b = await session();
    const res = await vaultWith({ agent: b.agent, level: 'templar', sid: b.sid }, forged("x' UNION SELECT 'attacker-secret", 'attacker-secret'));
    expect(res.text).not.toMatch(FLAG_RE);
    expect(labState(a.sid, 'inquisitor').signingKey).not.toBe(labState(b.sid, 'inquisitor').signingKey);
  });
});

describe('GK-06 divine', () => {
  it('only the exact allowlisted key id counts, with the genuine key; everything else is "Invalid token."', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const key = labState(sid, 'divine').signingKey;
    const bad = ['k1.key', 'K1', 'k1 ', ' k1', 'k1\n', "k1' --", '../keys/k1.key', '....//....//dev/null', 'k1/../k1', './k1', "x' UNION SELECT 'a", '', 'k0'];
    for (const kid of bad) {
      for (const k of [key, '', 'a']) {
        const res = await vaultWith(c, forged(kid, k));
        expect(res.text, `${kid} ${k.slice(0, 3)}`).not.toMatch(FLAG_RE);
        expect(res.text, kid).toMatch(/Invalid token\.</);
      }
    }
    expect((await vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS))).text).toMatch(/Invalid token/); // no kid at all
    expect((await vaultWith(c, signHmac('HS512', key, ADMIN_CLAIMS, { kid: 'k1' }))).text).toMatch(/Invalid token/);
    expect((await vaultWith(c, buildToken({ alg: 'HS256', kid: 'k1' }, ADMIN_CLAIMS))).text).toMatch(/Invalid token/);
    const real = await vaultWith(c, forged('k1', key));
    expect(real.text).toContain('Welcome, citadel_admin (role: admin)');
    expect(real.text).not.toMatch(FLAG_RE);
  });

});

describeLabView({
  challenge: GK06,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => login({ agent, level, sid }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'x' }),
});

describeJwtLabBasics({ challenge: GK06, path: LAB, mint: mintToken });
