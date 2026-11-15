// src/districts/gatekeeper/gk-05-jwt-key-confusion/gk-05.spec.ts
import { createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieHeader, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeJwtLabBasics } from '../_shared/jwt-lab.testkit.js';
import { buildToken, generateRsaKeyPair, parseToken, rsaVerify, signHmac, signRsa } from '../_shared/jwt.js';
import { GK05 } from './challenge.js'; // registers GK-05 before createApp() inside freshSession
import { cookieName, labState, mintToken } from './model.js';

const LAB = '/d/gatekeeper/jwt-key-confusion';
const ADMIN_CLAIMS = { sub: 'citadel_admin', role: 'admin' };

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

// One key pair for every attacker in this file: generating RSA keys is the slow part.
const attacker = generateRsaKeyPair();
const attackerJwk = createPublicKey(attacker.publicPem).export({ format: 'jwk' });

const session = () => freshSession();
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const vaultWith = (c: Ctx, token: string) =>
  c.agent.get(`${LAB}/vault?level=${c.level}`).set('Authorization', `Bearer ${token}`);
/** What a player does first: download the published public key (exact bytes). */
const publicKey = async (c: Ctx) => (await c.agent.get(`${LAB}/public.pem?level=${c.level}`)).text;
const tokenOf = (res: request.Response, level: Level) => setCookieValue(res, cookieName(level)) ?? '';

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: the header picks the algorithm; HS256 uses the PEM text as its HMAC secret.
const acolyteExploit: Script = async (c) => vaultWith(c, signHmac('HS256', await publicKey(c), ADMIN_CLAIMS));
// Templar: HS256 is blacklisted, HS384 is not.
const templarExploit: Script = async (c) => vaultWith(c, signHmac('HS384', await publicKey(c), ADMIN_CLAIMS));
// Inquisitor: RS family only, but the token carries its own verification key (jwk): sign with your own key pair.
const inquisitorExploit: Script = (c) => vaultWith(c, signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS, { jwk: attackerJwk }));

describeExploitMatrix<Script>({
  challenge: GK05,
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
  malformed: [], // no query, no parser errors shown: nothing that can raise a database error
  privileged: {
    name: 'the real admin token',
    input: async (c) => vaultWith(c, mintToken(c.sid, c.level, ADMIN_CLAIMS)),
    expect: /Welcome, citadel_admin \(role: admin\)/,
  },
});

describe('GK-05 keys and tokens', () => {
  it('tokens are RS256, signed by the server key, and the published key verifies them', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const res = await login(c);
      const token = tokenOf(res, level);
      const p = parseToken(token);
      expect(p.header, level).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(p.payload, level).toMatchObject({ sub: 'pilgrim', role: 'user' });
      expect(res.text, level).toContain(`<code>${token}</code>`);
      expect(rsaVerify('RS256', await publicKey(c), p.signingInput, p.signature), level).toBe(true);
      const line = setCookieHeader(res, cookieName(level))!;
      expect(line).toContain(`Path=${LAB}`);
      expect(line).not.toMatch(/HttpOnly/i); // deliberately editable: the page says so
      expect(res.text).toMatch(/devtools[\s\S]*Authorization: Bearer/);
    }
  });

  it('public.pem is plain text, exactly the lab\'s public key (a 2048-bit RSA key), and links from the page', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const res = await agent.get(`${LAB}/public.pem?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/^text\/plain/);
      expect(res.text, level).toBe(labState(sid, level).publicPem);
      expect(res.text, level).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
      expect(res.text, level).not.toContain('PRIVATE');
      expect(createPublicKey(res.text).asymmetricKeyDetails?.modulusLength, level).toBeGreaterThanOrEqual(2048);
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.text, level).toContain(`href="${LAB}/public.pem?level=${level}"`);
    }
  });

  it('keys are per player and per level: a key or token from one lab is worthless in another', async () => {
    const a = await session();
    const b = await session();
    const keys = new Set<string>();
    for (const level of LEVELS) keys.add(labState(a.sid, level).publicPem);
    keys.add(labState(b.sid, 'divine').publicPem);
    expect(keys.size).toBe(LEVELS.length + 1);
    const stolen = mintToken(a.sid, 'acolyte', ADMIN_CLAIMS);
    expect((await vaultWith({ agent: a.agent, level: 'acolyte', sid: a.sid }, stolen)).text).toMatch(FLAG_RE);
    for (const [who, level] of [[b, 'acolyte'], [a, 'templar'], [a, 'inquisitor'], [a, 'divine']] as const) {
      const res = await vaultWith({ agent: who.agent, level, sid: who.sid }, stolen);
      expect(res.text, level).not.toMatch(FLAG_RE);
      expect(res.text, level).toContain('Invalid token');
    }
    // the player's own public key is no secret, and in particular does not unlock another player's lab
    const mine = await publicKey({ agent: b.agent, level: 'acolyte', sid: b.sid });
    const res = await vaultWith({ agent: a.agent, level: 'acolyte', sid: a.sid }, signHmac('HS256', mine, ADMIN_CLAIMS));
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('flag only for a VERIFIED role "admin"; a missing or odd token is a plain denial, never a 500', async () => {
    const { agent, sid, app } = await session();
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const c: Ctx = { agent, level, sid };
      expect((await vaultWith(c, mintToken(sid, level, ADMIN_CLAIMS))).text, level).toMatch(FLAG_RE);
      expect((await vaultWith(c, mintToken(sid, level, { sub: 'pilgrim', role: 'user' }))).text, level).not.toMatch(FLAG_RE);
    }
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const none = await bare(app, sid).get(`${LAB}/vault?level=${level}`);
      expect(none.status).toBe(200);
      expect(none.text).toContain('Missing token');
      for (const t of ['', 'x', 'a.b.c', '..', 'x'.repeat(9000), buildToken({}, {}), buildToken({ alg: 1 }, {}), buildToken({ alg: 'constructor' }, ADMIN_CLAIMS, 'AAAA'), buildToken({ alg: 'toString' }, ADMIN_CLAIMS, 'AAAA'), buildToken({ alg: '__proto__' }, ADMIN_CLAIMS, 'AAAA'),
        buildToken({ alg: 'RS256', jwk: 'x' }, ADMIN_CLAIMS), buildToken({ alg: 'RS256', jwk: { kty: 'RSA' } }, ADMIN_CLAIMS),
        buildToken({ alg: 'RS256', jwk: [1] }, ADMIN_CLAIMS, 'AAAA'), buildToken({ alg: 'RS256', jwk: null }, ADMIN_CLAIMS, 'AAAA'),
        buildToken({ alg: 'RS256', jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } }, ADMIN_CLAIMS, 'AAAA'),
        buildToken({ alg: 'RS256' }, ADMIN_CLAIMS), buildToken({ alg: 'HS256' }, ADMIN_CLAIMS, '!')]) {
        const res = await vaultWith(c, t);
        expect(res.status, `${level} ${t.slice(0, 14)}`).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('GK-05 level behaviour', () => {
  const pem = (c: Ctx) => labState(c.sid, c.level).publicPem;

  it('acolyte: the header picks the algorithm; RS256 and HMAC-with-the-PEM both verify; a wrong key does not', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'acolyte', sid };
    expect((await vaultWith(c, mintToken(sid, c.level, ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
    for (const alg of ['HS256', 'HS384', 'HS512'] as const) {
      expect((await vaultWith(c, signHmac(alg, pem(c), ADMIN_CLAIMS))).text, alg).toMatch(FLAG_RE);
      expect((await vaultWith(c, signHmac(alg, 'wrong', ADMIN_CLAIMS))).text, alg).not.toMatch(FLAG_RE);
    }
    expect((await vaultWith(c, signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
    // the attacker's embedded key is not consulted at this level
    expect((await vaultWith(c, signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS, { jwk: attackerJwk }))).text).not.toMatch(FLAG_RE);
  });

  it('templar: HS256 is refused by name; HS384 and HS512 still use the PEM as the secret', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'templar', sid };
    const refused = await vaultWith(c, signHmac('HS256', pem(c), ADMIN_CLAIMS));
    expect(refused.text).not.toMatch(FLAG_RE);
    expect(refused.text).toContain('HS256');
    for (const alg of ['HS384', 'HS512'] as const) {
      expect((await vaultWith(c, signHmac(alg, pem(c), ADMIN_CLAIMS))).text, alg).toMatch(FLAG_RE);
      expect((await vaultWith(c, signHmac(alg, 'wrong', ADMIN_CLAIMS))).text, alg).not.toMatch(FLAG_RE);
    }
    expect((await vaultWith(c, mintToken(sid, c.level, ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
  });

  it('inquisitor: HMAC is refused outright; RS256/384/512 verify against the key in the header (jwk) when there is one', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    for (const alg of ['HS256', 'HS384', 'HS512'] as const) {
      const res = await vaultWith(c, signHmac(alg, pem(c), ADMIN_CLAIMS));
      expect(res.text, alg).not.toMatch(FLAG_RE);
      expect(res.text, alg).toContain('Invalid token');
    }
    for (const alg of ['RS256', 'RS384', 'RS512'] as const) {
      expect((await vaultWith(c, signRsa(alg, attacker.privatePem, ADMIN_CLAIMS, { jwk: attackerJwk }))).text, alg).toMatch(FLAG_RE);
    }
    // an EC key in the jwk, with a perfectly valid ECDSA signature, is not an RSA verifier
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const input = buildToken({ alg: 'RS256', jwk: ec.publicKey.export({ format: 'jwk' }) }, ADMIN_CLAIMS).slice(0, -1);
    const ecSig = createSign('sha256').update(input).sign(ec.privateKey).toString('base64url');
    const ecRes = await vaultWith(c, `${input}.${ecSig}`);
    expect(ecRes.text).not.toMatch(FLAG_RE);
    expect(ecRes.text).toContain('Invalid token');
    // without a jwk the server's own key is used: the attacker's signature fails
    expect((await vaultWith(c, signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS))).text).not.toMatch(FLAG_RE);
    // a jwk that does not match the signing key fails too
    const other = generateRsaKeyPair();
    const otherJwk = createPublicKey(other.publicPem).export({ format: 'jwk' });
    expect((await vaultWith(c, signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS, { jwk: otherJwk }))).text).not.toMatch(FLAG_RE);
    expect((await vaultWith(c, mintToken(sid, c.level, ADMIN_CLAIMS))).text).toMatch(FLAG_RE);
  });

  it('divine: RS256 only, key only from the server keystore; jwk, jku and kid in the header are ignored', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const tries = [
      signHmac('HS256', pem(c), ADMIN_CLAIMS), signHmac('HS384', pem(c), ADMIN_CLAIMS), signHmac('HS512', pem(c), ADMIN_CLAIMS),
      signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS, { jwk: attackerJwk }),
      signRsa('RS256', attacker.privatePem, ADMIN_CLAIMS, { jku: `${LAB}/public.pem`, kid: 'attacker' }),
      signRsa('RS384', attacker.privatePem, ADMIN_CLAIMS, { jwk: attackerJwk }),
      buildToken({ alg: 'none' }, ADMIN_CLAIMS), buildToken({ alg: 'RS256' }, ADMIN_CLAIMS),
      // the real key, but a size Divine does not pin
      signRsa('RS384', labState(sid, 'divine').privatePem, ADMIN_CLAIMS), signRsa('RS512', labState(sid, 'divine').privatePem, ADMIN_CLAIMS),
    ];
    for (const t of tries) {
      const res = await vaultWith(c, t);
      expect(res.text).not.toMatch(FLAG_RE);
      expect(res.text).toContain('Invalid token');
    }
    // a genuine RS256 token still verifies, whatever stray header fields it carries
    const real = await vaultWith(c, signRsa('RS256', labState(sid, 'divine').privatePem, ADMIN_CLAIMS, { jwk: attackerJwk, kid: 'x' }));
    expect(real.text).toContain('Welcome, citadel_admin (role: admin)');
    expect(real.text).not.toMatch(FLAG_RE);
  });

});

describeLabView({
  challenge: GK05,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => login({ agent, level, sid }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'x' }),
});

describeJwtLabBasics({ challenge: GK05, path: LAB, mint: mintToken });
