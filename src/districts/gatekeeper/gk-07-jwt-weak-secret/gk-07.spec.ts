// src/districts/gatekeeper/gk-07-jwt-weak-secret/gk-07.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, setCookieHeader, setCookieValue, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeJwtLabBasics } from '../_shared/jwt-lab-basics.spec.js';
import { buildToken, hmacSignature, parseToken, signHmac } from '../_shared/jwt.js';
import { GK07 } from './challenge.js'; // registers GK-07 before createApp() inside freshSession
import { cookieName, labState, mintToken, wordlist as lines } from './model.js';
import * as templar from './levels/templar.js';

const LAB = '/d/gatekeeper/jwt-weak-secret';
const ADMIN_CLAIMS = { sub: 'citadel_admin', role: 'admin' };
const TOKEN_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const session = () => freshSession();
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const vaultWith = (c: Ctx, token: string) =>
  c.agent.get(`${LAB}/vault?level=${c.level}`).set('Authorization', `Bearer ${token}`);
const tokenOf = (res: request.Response, level: Level) => setCookieValue(res, cookieName(level)) ?? '';

/** What the player sees and downloads. */
const sampleToken = async (c: Ctx) => /Sample token: <code>([^<]+)<\/code>/.exec((await c.agent.get(`${LAB}?level=${c.level}`)).text)?.[1] ?? '';
const wordlist = async (c: Ctx) => (await c.agent.get(`${LAB}/wordlist.txt?level=${c.level}`)).text.split('\n').filter((l) => l !== '');
const releaseNotes = async (c: Ctx) => (await c.agent.get(`${LAB}/release-notes.txt?level=${c.level}`)).text;

/** Offline cracking, as a player would script it: the first candidate whose HMAC matches the token's signature. */
function crack(token: string, candidates: Iterable<string>): string | undefined {
  const p = parseToken(token);
  for (const k of candidates) if (hmacSignature('HS256', k, p.signingInput) === p.signature) return k;
  return undefined;
}
function* mangled(words: readonly string[]): Generator<string> {
  for (const w of words) for (let n = 0; n < 100; n++) yield `${w}${String(n).padStart(2, '0')}`;
}

// --- The exploits ---------------------------------------------------------------------------
// When the secret does not fall to the technique (any higher level), the script forges with a wrong guess.
const NOT_CRACKED = 'not-the-secret';
// Acolyte: the secret is a plain word from the served list.
const acolyteExploit: Script = async (c) => {
  const secret = crack(await sampleToken(c), await wordlist(c)) ?? NOT_CRACKED;
  return vaultWith(c, signHmac('HS256', secret, ADMIN_CLAIMS));
};
// Templar: a word plus two digits.
const templarExploit: Script = async (c) => {
  const secret = crack(await sampleToken(c), mangled(await wordlist(c))) ?? NOT_CRACKED;
  return vaultWith(c, signHmac('HS256', secret, ADMIN_CLAIMS));
};
// Inquisitor: the current key is strong, but the release notes carry an old token of the retired key 2024.
const inquisitorExploit: Script = async (c) => {
  const old = TOKEN_RE.exec(await releaseNotes(c))?.[0];
  const secret = old === undefined ? undefined : crack(old, await wordlist(c));
  return vaultWith(c, signHmac('HS256', secret ?? NOT_CRACKED, ADMIN_CLAIMS, { kid: '2024' }));
};

describeExploitMatrix<Script>({
  challenge: GK07,
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

describe('GK-07 secrets', () => {
  it('acolyte: a word from the served wordlist; templar: a word plus two digits; inquisitor and divine: 256 random bits', async () => {
    const { agent, sid } = await session();
    const words = await wordlist({ agent, level: 'acolyte', sid });
    expect(words.length).toBeGreaterThanOrEqual(100);
    expect(words).toContain(labState(sid, 'acolyte').secret);
    const t = labState(sid, 'templar').secret;
    expect(t).toMatch(/\d\d$/);
    expect(words).toContain(t.slice(0, -2));
    expect(words).not.toContain(t);
    expect(labState(sid, 'inquisitor').secret).toMatch(/^[0-9a-f]{64}$/);
    expect(labState(sid, 'divine').secret).toMatch(/^[0-9a-f]{64}$/);
    expect(labState(sid, 'divine').legacySecret).toBeUndefined();
    expect(labState(sid, 'acolyte').legacySecret).toBeUndefined();
    expect(labState(sid, 'templar').legacySecret).toBeUndefined();
    const legacy = labState(sid, 'inquisitor').legacySecret;
    expect(legacy).toBeDefined();
    expect(words).toContain(legacy);
    expect(legacy).not.toBe(labState(sid, 'inquisitor').secret);
  });

  it('secrets are per player and per level (the strong ones never repeat; weak ones are only guessable, not shared state)', async () => {
    const a = await session();
    const b = await session();
    const strong = new Set<string>();
    for (const s of [a, b]) for (const l of ['inquisitor', 'divine'] as const) strong.add(labState(s.sid, l).secret);
    expect(strong.size).toBe(4);
    const stolen = mintToken(a.sid, 'inquisitor', ADMIN_CLAIMS);
    expect((await vaultWith({ agent: a.agent, level: 'inquisitor', sid: a.sid }, stolen)).text).toMatch(FLAG_RE);
    for (const [who, level] of [[b, 'inquisitor'], [a, 'divine'], [a, 'templar'], [a, 'acolyte']] as const) {
      const res = await vaultWith({ agent: who.agent, level, sid: who.sid }, stolen);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('the cracking itself works as designed: it recovers exactly the lab secret, and only at the intended levels', async () => {
    const { agent, sid } = await session();
    const c = (level: Level): Ctx => ({ agent, level, sid });
    const words = await wordlist(c('acolyte'));
    expect(crack(await sampleToken(c('acolyte')), words)).toBe(labState(sid, 'acolyte').secret);
    expect(crack(await sampleToken(c('templar')), words)).toBeUndefined();
    expect(crack(await sampleToken(c('templar')), mangled(words))).toBe(labState(sid, 'templar').secret);
    expect(crack(await sampleToken(c('inquisitor')), mangled(words))).toBeUndefined();
    expect(crack(await sampleToken(c('divine')), mangled(words))).toBeUndefined();
  });
});

describe('GK-07 templar secret', () => {
  it('is never itself a wordlist entry (else the plain-wordlist attack of acolyte would beat templar)', () => {
    // ['pw', 'pw12']: "pw" + "12" collides with the list entry "pw12" (as "password1" + "23" does in the real list)
    const words = ['pw', 'pw12'];
    for (let i = 0; i < 3000; i++) {
      const { secret } = templar.createKeys(words);
      expect(words, secret).not.toContain(secret);
      expect(secret).toMatch(/^pw(12)?\d\d$/);
    }
  });

  it('the real wordlist really has such collisions, and the lab secret is never in it', () => {
    const words = new Set(lines());
    const collisions = [...words].filter((w) => [...Array(100).keys()].some((n) => words.has(`${w}${String(n).padStart(2, '0')}`)));
    expect(collisions.length).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) expect(words.has(templar.createKeys(lines()).secret)).toBe(false);
  });
});

describe('GK-07 the page and its files', () => {
  it('shows a sample token (stable across visits, a genuine non-admin token of that lab) and links the wordlist and release notes', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const t = await sampleToken(c);
      expect(t, level).toMatch(TOKEN_RE);
      expect(await sampleToken(c), level).toBe(t);
      const p = parseToken(t);
      expect(p.header, level).toMatchObject({ alg: 'HS256', typ: 'JWT' });
      expect(p.payload, level).toMatchObject({ sub: 'pilgrim', role: 'user' });
      expect(p.payload.role).not.toBe('admin');
      expect(hmacSignature('HS256', labState(sid, level).secret, p.signingInput), level).toBe(p.signature);
      expect((await vaultWith(c, t)).text, level).toMatch(/Welcome, pilgrim \(role: user\)/);
      const page = (await agent.get(`${LAB}?level=${level}`)).text;
      expect(page, level).toContain(`href="${LAB}/wordlist.txt?level=${level}"`);
      expect(page, level).toContain(`href="${LAB}/release-notes.txt?level=${level}"`);
    }
  });

  it('sign-in issues a token as a lab cookie (per level, canonical path), shown on the page; only the inquisitor token names its key', async () => {
    const { agent } = await session();
    for (const level of LEVELS) {
      const res = await login({ agent, level, sid: '' });
      const token = tokenOf(res, level);
      const p = parseToken(token);
      expect(p.header, level).toMatchObject({ alg: 'HS256', typ: 'JWT' });
      expect(p.header.kid, level).toBe(level === 'inquisitor' ? '2025' : undefined);
      expect(res.text, level).toContain(`<code>${token}</code>`);
      const line = setCookieHeader(res, cookieName(level))!;
      expect(line).toContain(`Path=${LAB}`);
      expect(line).not.toMatch(/HttpOnly/i); // deliberately editable: the page says so
      expect(res.text).toMatch(/devtools[\s\S]*Authorization: Bearer/);
    }
  });

  it('wordlist.txt is plain text, one word per line, with no blank lines; the same list at every level', async () => {
    const { agent } = await session();
    const lists: string[] = [];
    for (const level of LEVELS) {
      const res = await agent.get(`${LAB}/wordlist.txt?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/^text\/plain/);
      expect(res.text, level).not.toMatch(/\n\n/);
      lists.push(res.text);
    }
    expect(new Set(lists).size).toBe(1);
  });

  it('release notes: only the inquisitor lab carries a token (of the retired key 2024); it verifies with the legacy secret', async () => {
    const { agent, sid } = await session();
    for (const level of LEVELS) {
      const res = await agent.get(`${LAB}/release-notes.txt?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/^text\/plain/);
      // the kid line is only true (and only shown) where tokens carry a kid
      expect(/key id \(kid\)/.test(res.text), level).toBe(level === 'inquisitor');
      if (level !== 'inquisitor') { expect(res.text, level).not.toMatch(TOKEN_RE); continue; }
      const token = TOKEN_RE.exec(res.text)![0];
      const p = parseToken(token);
      expect(p.header).toMatchObject({ alg: 'HS256', kid: '2024' });
      expect(p.payload.role).toBe('user');
      expect(hmacSignature('HS256', labState(sid, level).legacySecret!, p.signingInput)).toBe(p.signature);
      expect(hmacSignature('HS256', labState(sid, level).secret, p.signingInput)).not.toBe(p.signature);
    }
  });

  it('flag only for a VERIFIED role "admin"; missing or odd tokens are plain denials, never a 500', async () => {
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
      const key = labState(sid, level).secret;
      for (const kid of [undefined, null, 1, [], {}, '', '2024', '2025', '__proto__', 'constructor', 'x'.repeat(5000)]) {
        const res = await vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS, kid === undefined ? {} : { kid }));
        expect(res.status, `${level} ${JSON.stringify(kid)?.slice(0, 12)}`).toBe(200);
        // only the inquisitor lab selects a key by kid; every other level ignores it
        const accepted = level !== 'inquisitor' || kid === '2025';
        const label = `${level} kid=${JSON.stringify(kid)?.slice(0, 12)}`;
        if (!accepted) { expect(res.text, label).not.toMatch(FLAG_RE); expect(res.text, label).toContain('Invalid token'); }
        else if (level === 'divine') expect(res.text, label).toContain('Welcome, citadel_admin (role: admin)');
        else expect(res.text, label).toMatch(FLAG_RE);
      }
      for (const t of ['', 'x', 'a.b.c', 'x'.repeat(9000), buildToken({}, {}), buildToken({ alg: 'none' }, ADMIN_CLAIMS),
        buildToken({ alg: 'HS256' }, ADMIN_CLAIMS), buildToken({ alg: 'HS256' }, ADMIN_CLAIMS, 'AAAA')]) {
        const res = await vaultWith(c, t);
        expect(res.status, level).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('GK-07 level behaviour', () => {
  it('acolyte and templar: any token signed with the lab secret is accepted, whatever kid it names; only HS256', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const { agent, sid } = await session();
      const c: Ctx = { agent, level, sid };
      const key = labState(sid, level).secret;
      expect((await vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS))).text, level).toMatch(FLAG_RE);
      expect((await vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS, { kid: '2024' }))).text, level).toMatch(FLAG_RE);
      expect((await vaultWith(c, signHmac('HS512', key, ADMIN_CLAIMS))).text, level).not.toMatch(FLAG_RE);
      expect((await vaultWith(c, signHmac('HS256', `${key}x`, ADMIN_CLAIMS))).text, level).not.toMatch(FLAG_RE);
    }
  });

  it('inquisitor: kid 2025 is the strong current key, kid 2024 the weak legacy one; nothing else, and keys do not cross', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    const { secret, legacySecret } = labState(sid, 'inquisitor');
    const ok = (kid: unknown, key: string) => vaultWith(c, signHmac('HS256', key, ADMIN_CLAIMS, kid === undefined ? {} : { kid }));
    expect((await ok('2025', secret)).text).toMatch(FLAG_RE);
    expect((await ok('2024', legacySecret!)).text).toMatch(FLAG_RE);
    for (const [kid, key] of [['2024', secret], ['2025', legacySecret!], [undefined, secret], [undefined, legacySecret!], ['2023', legacySecret!], ['', secret], [2024, legacySecret!]] as const) {
      const res = await ok(kid, key);
      expect(res.text, `${String(kid)}`).not.toMatch(FLAG_RE);
      expect(res.text, `${String(kid)}`).toContain('Invalid token');
    }
    expect((await vaultWith(c, signHmac('HS512', legacySecret!, ADMIN_CLAIMS, { kid: '2024' }))).text).not.toMatch(FLAG_RE);
  });

  it('divine: one strong key, kid is not trusted (ignored), no legacy key, algorithm pinned, signature compared in constant time', async () => {
    const { agent, sid } = await session();
    const c: Ctx = { agent, level: 'divine', sid };
    const { secret } = labState(sid, 'divine');
    for (const t of [
      signHmac('HS256', 'wrong', ADMIN_CLAIMS), signHmac('HS256', 'wrong', ADMIN_CLAIMS, { kid: '2024' }),
      signHmac('HS512', secret, ADMIN_CLAIMS), buildToken({ alg: 'none' }, ADMIN_CLAIMS), buildToken({ alg: 'HS256' }, ADMIN_CLAIMS),
    ]) {
      const res = await vaultWith(c, t);
      expect(res.text).not.toMatch(FLAG_RE);
      expect(res.text).toMatch(/Invalid token\.</);
    }
    for (const extra of [{}, { kid: '2024' }, { kid: 'anything' }]) {
      const real = await vaultWith(c, signHmac('HS256', secret, ADMIN_CLAIMS, extra));
      expect(real.text).toContain('Welcome, citadel_admin (role: admin)');
      expect(real.text).not.toMatch(FLAG_RE);
    }
  });

});

describeLabView({
  challenge: GK07,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => login({ agent, level, sid }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'x' }),
});

describeJwtLabBasics({ challenge: GK07, path: LAB, mint: mintToken });
