// src/districts/relic-market/rm-01-sqli-product-search/rm-01.spec.ts
import { describe, it, expect } from 'vitest';
import { describeExploitMatrix, describeLabView, freshSession, FLAG_RE, DB_ERROR_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { RM01 } from './challenge.js'; // registers RM-01 before createApp() inside freshSession
import { catalogDb, vaultKey } from './model.js';
import * as divineLevel from './levels/divine.js';

const LAB = '/d/relic-market/sqli-product-search';
interface Search { q?: string; max?: string }
const search = (agent: Agent, level: string, body: Search) => agent.post(`${LAB}?level=${level}`).type('form').send({ ...body });
/** The result table's rows as the page shows them. */
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr data-row[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

describeExploitMatrix<Search>({
  challenge: RM01,
  path: LAB,
  send: (agent, _level, body, url) => agent.post(url).type('form').send({ ...body }),
  exploits: {
    // Both inputs are concatenated: a UNION from the secrets table (the 4 columns of the first SELECT).
    acolyte: { q: "x' UNION SELECT name, value, 0, 'vault' FROM secrets-- " },
    // The keyword filter runs once, so nested keywords survive it.
    templar: { q: "x' UNIunionON SELselectECT name, value, 0, 'vault' FROM secrets-- " },
    // q is bound, but max is only "validated" with parseInt and the raw string is still concatenated.
    inquisitor: { max: "1000000 UNION SELECT name, value, 0, 'vault' FROM secrets" },
  },
  resisted: { acolyte: 'No relics match', templar: 'No relics match', inquisitor: 'Max price must be a whole number of dollars.' },
  legit: [{ name: 'search for chalice', input: { q: 'chalice' }, expect: 'Silver Chalice' }],
  malformed: [
    { name: 'lone quote in q', input: { q: "'" }, levels: ['acolyte', 'templar'] },
    { name: 'lone quote after the max', input: { max: "1'" }, levels: ['acolyte', 'templar', 'inquisitor'] },
  ],
  privileged: null,
});

describeLabView({
  challenge: RM01,
  path: LAB,
  account: /You are browsing as a guest\./,
  echoField: 'q',
  extra: { max: '1000' },
  oddBodies: [{ q: { a: 1 }, max: ['1'] }, { q: ['a', 'b'] }, { max: { $ne: 1 } }, [], { 'q[__proto__]': 'x', constructor: 1 }],
  ok: (agent, level) => search(agent, level, { q: 'chalice' }),
  bad: (agent, level) => search(agent, level, { q: 'zzzz-nothing' }),
});

describeCurlExample({ challenge: RM01, path: LAB, curl: () => ({ path: '/', form: ['q=chalice', 'max=1000'] }) });

describe('RM-01 product search', () => {
  it('every level has its own random vault key, stable per level, and nothing else holds it', () => {
    const keys = LEVELS.map((l) => vaultKey(l));
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{24}$/);
    expect(new Set(keys).size).toBe(LEVELS.length);
    expect(vaultKey('templar')).toBe(vaultKey('templar'));
    for (const l of LEVELS) {
      const rows = catalogDb(l).prepare('SELECT value FROM secrets').all() as { value: string }[];
      expect(rows.map((r) => r.value)).toContain(vaultKey(l));
      expect(JSON.stringify(catalogDb(l).prepare('SELECT * FROM products').all())).not.toContain(vaultKey(l));
    }
  });

  it('a vault key dumped at one level is worthless at another (it is never a result cell there)', async () => {
    const { agent } = await freshSession();
    const dump = (await search(agent, 'acolyte', { q: "x' UNION SELECT name, value, 0, 'vault' FROM secrets-- " })).text;
    expect(dump).toContain(vaultKey('acolyte'));
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const text = (await search(agent, level, { q: vaultKey('acolyte') })).text;
      expect(text, level).not.toMatch(FLAG_RE);
    }
  });

  it('the echo of the search term is not a result cell: searching for the real key proves nothing, even when rows come back', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const key = vaultKey(level);
      const plain = (await search(agent, level, { q: key })).text;
      expect(plain, level).toContain(key); // echoed in the q field
      expect(plain, level).not.toMatch(FLAG_RE);
      // At Acolyte and Templar this injects into the SQL: every visible relic comes back (rows) AND the key is in q.
      const withRows = (await search(agent, level, { q: `' OR '${key}'='${key}' OR '1'='1` })).text;
      expect(withRows, level).toContain(key);
      if (level === 'acolyte' || level === 'templar') expect(rowsOf(withRows).length, `${level} must return rows`).toBeGreaterThan(5);
      expect(withRows, level).not.toMatch(FLAG_RE);
    }
  });

  it('hidden relics never show in a plain search, at any level', async () => {
    const { agent } = await freshSession();
    const hidden = (catalogDb('acolyte').prepare('SELECT name FROM products WHERE hidden = 1').all() as { name: string }[]).map((r) => r.name);
    expect(hidden.length).toBeGreaterThan(0);
    for (const level of LEVELS) {
      const text = (await search(agent, level, { q: '' })).text;
      expect(rowsOf(text).length, level).toBeGreaterThan(5);
      for (const name of hidden) expect(text, level).not.toContain(name);
    }
  });

  it('an empty max means no limit, a number limits the price (whole dollars)', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const all = rowsOf((await search(agent, level, { q: '', max: '' })).text);
      const cheap = rowsOf((await search(agent, level, { q: '', max: '10' })).text);
      expect(cheap.length, level).toBeGreaterThan(0);
      expect(cheap.length, level).toBeLessThan(all.length);
    }
  });

  it('acolyte: injected rows come back as ordinary result rows, 50 at most (the cap is the reader, not a LIMIT)', async () => {
    const { agent } = await freshSession();
    const cross = "x' UNION SELECT a.name, b.name, a.id, b.id FROM products a, products b, products c-- ";
    const html = (await search(agent, 'acolyte', { q: cross })).text;
    expect(rowsOf(html)).toHaveLength(50);
    expect(html).toContain('50 relics');
  });

  it('result cells are clipped to 200 characters', async () => {
    const { agent } = await freshSession();
    const long = "x' UNION SELECT name, hex(zeroblob(150)), 0, 'long' FROM secrets-- ";
    const html = (await search(agent, 'acolyte', { q: long })).text;
    expect(html).toMatch(/0{200}/);
    expect(html).not.toMatch(/0{201}/);
  });

  it('a row forged by injection is escaped, a non-integer price cell is shown as text, not a 500', async () => {
    const { agent } = await freshSession();
    const forged = "x' UNION SELECT '<img src=x onerror=alert(1)>', 'c', 'not-a-price', 'd' FROM secrets-- ";
    const res = await search(agent, 'acolyte', { q: forged });
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('not-a-price');
  });

  it('templar: the keyword filter runs once, on both fields, case-insensitively', async () => {
    const { agent } = await freshSession();
    const plain = (await search(agent, 'templar', { q: "x' UNION SELECT name, value, 0, 'v' FROM secrets-- " })).text;
    expect(plain).toMatch(/Database error/); // UNION and SELECT were removed, what is left is broken SQL
    expect(plain).not.toMatch(FLAG_RE);
    const viaMax = (await search(agent, 'templar', { max: '1000000 UNIunionON SELselectECT name, value, 0, 1 FROM secrets' })).text;
    expect(viaMax).toContain(vaultKey('templar'));
    expect(viaMax).toMatch(FLAG_RE);
  });

  it('inquisitor: q is bound (a quote is data), max must start with a number', async () => {
    const { agent } = await freshSession();
    const quote = (await search(agent, 'inquisitor', { q: "'" })).text;
    expect(quote).toContain('No relics match');
    expect(quote).not.toMatch(DB_ERROR_RE);
    for (const max of ['abc', "'", '-', ' ', 'x1']) {
      expect((await search(agent, 'inquisitor', { max })).text, max).toContain('Max price must be a number.');
    }
  });

  it('divine: both fields bound, max is whole dollars only (anchored, 1-7 digits), generic errors', async () => {
    const { agent } = await freshSession();
    for (const max of ['1.5', '-1', '1e3', '12345678', ' 5', '5 ', '5\n', '0x10', "5' OR '1'='1"]) {
      const text = (await search(agent, 'divine', { q: '', max })).text;
      expect(text, JSON.stringify(max)).toContain('Max price must be a whole number of dollars.');
      expect(rowsOf(text), JSON.stringify(max)).toHaveLength(0);
    }
    expect(rowsOf((await search(agent, 'divine', { q: '', max: '0000010' })).text).length).toBeGreaterThan(0);
    expect(rowsOf((await search(agent, 'divine', { q: "' OR 1=1 --", max: '' })).text)).toHaveLength(0);
  });

  it('divine reads at most 50 rows', () => {
    const many = divineLevel.search(catalogDb('divine'), '', '1000000');
    expect(Array.isArray(many)).toBe(true);
    expect((many as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it('has no Restart: the lab mutates nothing', async () => {
    const { agent } = await freshSession();
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(404);
  });
});
