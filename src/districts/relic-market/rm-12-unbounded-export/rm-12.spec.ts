// src/districts/relic-market/rm-12-unbounded-export/rm-12.spec.ts
import { describe, it, expect } from 'vitest';
import { describeExploitMatrix, describeLabView, freshSession, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { RM12 } from './challenge.js'; // registers RM-12 before createApp() inside freshSession
import { FANOUT, FLAG_COST, TOTAL_ROWS, proves } from './model.js';
import * as divine from './levels/divine.js';

const LAB = '/d/relic-market/unbounded-export';
const cursorOf = (offset: number): string => Buffer.from(String(offset)).toString('base64url');
/** GET <lab>/api/export with this query string (`limit=..&expand=..`), at `level`. */
const exp = (agent: Agent, level: Level, qs = '') => agent.get(`${LAB}/api/export?level=${level}${qs === '' ? '' : `&${qs}`}`);

interface Export {
  rows: number; cost: number | string; returned: number; next: string | null; data: unknown[]; note: string; flag?: string;
}
const json = (res: { body: unknown }): Export => res.body as Export;
const TOO_MANY = Array.from({ length: 9 }, () => 'related').join('.');

describeExploitMatrix<string>({
  challenge: RM12,
  path: LAB,
  send: (agent, level, qs) => exp(agent, level, qs),
  // Acolyte: no cap. Templar: a legacy branch treats a limit of 0 as "everything". Inquisitor: the page size is capped,
  // but each .related multiplies the work by 20 and no depth or budget is checked.
  exploits: { acolyte: 'limit=1000000', templar: 'limit=0', inquisitor: 'expand=product.related.related.related' },
  resisted: {
    acolyte: 'limit must be between 1 and 100', templar: 'limit must be between 1 and 100', inquisitor: 'expand: at most one level',
  },
  resistedStatus: 400,
  legit: [
    { name: 'ten rows with the product expanded', input: 'limit=10&expand=product', expect: '"returned":10' },
    { name: 'the default page', input: '', expect: '"rows":100' },
    { name: 'the next page by cursor', input: `limit=5&cursor=${cursorOf(5)}`, expect: '"returned":5' },
  ],
  malformed: [],
  privileged: null, // an API with no sign-in and no privileged identity
});

describeLabView({
  challenge: RM12,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'limit',
  extra: { intent: 'export' },
  oddBodies: [
    { intent: 'export', limit: { a: 1 }, expand: ['product'] }, { intent: 'export', limit: ['1', '2'] },
    { intent: ['export'] }, { intent: { a: 1 } }, [],
  ],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'export', limit: '5', expand: 'product' }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'export', limit: '5', expand: 'nope' }),
});

describeCurlExample({ challenge: RM12, path: LAB, curl: () => ({ path: '/api/export' }) });

describe('RM-12 seams and the proof', () => {
  it('the ledger is virtual: 2 500 000 rows, a fan-out graph, and the flag needs a cost of 100 000', () => {
    expect(TOTAL_ROWS).toBe(2_500_000);
    expect(FANOUT).toEqual({ product: 1, related: 20, reviews: 50 });
    expect(FLAG_COST).toBe(100_000);
    expect(proves(99_999)).toBe(false);
    expect(proves(100_000)).toBe(true);
  });
});

describe('RM-12 acolyte', () => {
  it('limit=1000000 plans a million rows, materializes a 20-row preview and says what the real server would have built', async () => {
    const { agent } = await freshSession();
    const res = await exp(agent, 'acolyte', 'limit=1000000');
    expect(res.status).toBe(200);
    const j = json(res);
    expect(j).toMatchObject({ rows: 1_000_000, cost: 1_000_000, returned: 20, next: cursorOf(1_000_000) });
    expect(j.data).toHaveLength(20);
    expect(j.note).toBe('Truncated by the lab: the real server would have built 1000000 rows.');
    expect(j.flag).toMatch(/^HVWA\{[0-9a-f]{32}\}$/);
  });

  it('there is no cap at all: a limit beyond the ledger is the rest of the ledger, offset by the cursor', async () => {
    const { agent } = await freshSession();
    expect(json(await exp(agent, 'acolyte', 'limit=99999999999999999999')).rows).toBe(TOTAL_ROWS);
    expect(json(await exp(agent, 'acolyte', `limit=1000000&cursor=${cursorOf(2_400_000)}`)).rows).toBe(100_000);
    const last = json(await exp(agent, 'acolyte', `limit=10&cursor=${cursorOf(TOTAL_ROWS)}`));
    expect(last).toMatchObject({ rows: 0, returned: 0, next: null, data: [] });
    expect(last.flag).toBeUndefined();
  });

  it('a negative or junk limit is an empty or default page, never negative rows', async () => {
    const { agent } = await freshSession();
    expect(json(await exp(agent, 'acolyte', 'limit=-5')).rows).toBe(0);
    for (const limit of ['abc', '', '1.5e3x']) expect(json(await exp(agent, 'acolyte', `limit=${limit}`)).rows, limit).toBe(limit === '1.5e3x' ? 1 : 100);
  });
});

describe('RM-12 templar', () => {
  it('limit=0 (the legacy "everything" branch) plans the whole ledger, fast, in a small JSON', async () => {
    const { agent } = await freshSession();
    const t0 = Date.now();
    const res = await exp(agent, 'templar', 'limit=0');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(200);
    expect(res.text.length).toBeLessThan(64 * 1024);
    expect(json(res)).toMatchObject({ rows: TOTAL_ROWS, cost: TOTAL_ROWS, returned: 20 });
    expect(json(res).flag).toMatch(/^HVWA\{/);
    expect(json(await exp(agent, 'templar', `limit=-1&cursor=${cursorOf(1000)}`)).rows).toBe(TOTAL_ROWS - 1000);
  });

  it('a limit above 100 is capped to 100 (no flag); the cap is the naive part', async () => {
    const { agent } = await freshSession();
    for (const limit of ['101', '1000000', '99999999999999999999']) {
      const j = json(await exp(agent, 'templar', `limit=${limit}`));
      expect(j.rows, limit).toBe(100);
      expect(j.flag, limit).toBeUndefined();
    }
  });
});

describe('RM-12 inquisitor', () => {
  it('the page size is clamped to 1-100, and 0 is no way round it', async () => {
    const { agent } = await freshSession();
    for (const [limit, rows] of [['0', 100], ['-7', 1], ['1000000', 100], ['50', 50], ['abc', 100]] as const) {
      expect(json(await exp(agent, 'inquisitor', `limit=${limit}`)).rows, limit).toBe(rows);
    }
  });

  it('each .related multiplies the work by 20: 100 x 20^3 = 800 000 earns the flag, 100 x 20^2 does not', async () => {
    const { agent } = await freshSession();
    const deep = json(await exp(agent, 'inquisitor', 'expand=product.related.related.related'));
    expect(deep).toMatchObject({ rows: 100, cost: 800_000 });
    expect(deep.flag).toMatch(/^HVWA\{/);
    const shallow = json(await exp(agent, 'inquisitor', 'expand=product.related.related'));
    expect(shallow).toMatchObject({ rows: 100, cost: 40_000 });
    expect(shallow.flag).toBeUndefined();
    expect(json(await exp(agent, 'inquisitor', 'expand=product.reviews')).cost).toBe(5000);
  });
});

describe('RM-12 cost is arithmetic, never work', () => {
  it('a million-row plan with the deepest expansion answers at once in a small JSON; costs from 10^15 read ">= 10^15"', async () => {
    const { agent } = await freshSession();
    const expand = `product.${TOO_MANY}`; // product + 9 x related = 10 segments
    const t0 = Date.now();
    const res = await exp(agent, 'acolyte', `limit=99999999&expand=${expand}`);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.text.length).toBeLessThan(64 * 1024);
    const j = json(res);
    expect(j.cost).toBe('>= 10^15');
    expect(j.note).toBe('Truncated by the lab: the real server would have built >= 10^15 rows.');
    expect(j.flag).toMatch(/^HVWA\{/);
    const inq = json(await exp(agent, 'inquisitor', `expand=${expand}`));
    expect(inq.cost).toBe(100 * 20 ** 9); // 5.12e13: still a number
  });

  it('the preview holds at most 20 rows, each with at most 3 children per expansion and 3 levels', async () => {
    const { agent } = await freshSession();
    const j = json(await exp(agent, 'inquisitor', 'expand=product.related.related.related'));
    expect(j.data).toHaveLength(20);
    const count = (v: unknown): number => (Array.isArray(v) ? v.reduce<number>((n, x) => n + count(x), 0) : v !== null && typeof v === 'object' ? 1 + Object.values(v).reduce<number>((n, x) => n + count(x), 0) : 0);
    const nodes = count(j.data);
    expect(nodes).toBeLessThan(20 * 80);
    const row = j.data[0] as { product?: { related?: unknown[] } };
    expect(row.product?.related).toHaveLength(3);
  });

  it('rows are derived from the row number: the same row is the same, and consecutive pages do not overlap', async () => {
    const { agent } = await freshSession();
    const first = json(await exp(agent, 'divine', 'limit=3'));
    const again = json(await exp(agent, 'divine', 'limit=3'));
    expect(again.data).toEqual(first.data);
    const second = json(await exp(agent, 'divine', `limit=3&cursor=${first.next}`));
    expect(second.data).not.toEqual(first.data);
    expect((first.data as { id: number }[]).map((r) => r.id)).toEqual([1, 2, 3]);
    expect((second.data as { id: number }[]).map((r) => r.id)).toEqual([4, 5, 6]);
  });
});

describe('RM-12 expand parsing (not the lesson) at acolyte, templar and inquisitor', () => {
  it('an unknown relation, a relation after a leaf, a duplicate "product" and more than 10 segments are a 400', async () => {
    const { agent } = await freshSession();
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      for (const expand of ['foo', 'constructor', '__proto__', 'product.nope', 'product.reviews.related', 'product.product', 'related', '.', 'product..related', `product.${TOO_MANY}.related`]) {
        const res = await exp(agent, level, `expand=${encodeURIComponent(expand)}`);
        expect(res.status, `${level} ${expand}`).toBe(400);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
    expect((await exp(agent, 'acolyte', 'expand=product.reviews')).status).toBe(200);
  });

  it('an over-long expand is refused before it is split', async () => {
    const { agent } = await freshSession();
    expect((await exp(agent, 'acolyte', `expand=${'product.'.repeat(200)}`)).status).toBe(400);
  });
});

describe('RM-12 divine', () => {
  it('limit must be 1 to 100 digits-only (leading zeros are digits); a missing limit is the default page of 100', async () => {
    const { agent } = await freshSession();
    for (const limit of ['0', '101', '-1', '1000', '1e2', '+5', ' 5', '5 ', '1.5', 'abc', '', '0000', '١٢']) {
      const res = await exp(agent, 'divine', `limit=${encodeURIComponent(limit)}`);
      expect(res.status, JSON.stringify(limit)).toBe(400);
      expect(res.text, limit).toContain('limit must be between 1 and 100.');
    }
    for (const limit of ['1', '100', '010']) expect((await exp(agent, 'divine', `limit=${limit}`)).status, limit).toBe(200);
    expect(json(await exp(agent, 'divine', '')).rows).toBe(100);
  });

  it('at most one expansion, and only "product"', async () => {
    const { agent } = await freshSession();
    for (const expand of ['product.related', 'product.reviews', 'product.related.related.related', 'product.']) {
      const res = await exp(agent, 'divine', `expand=${expand}`);
      expect(res.status, expand).toBe(400);
      expect(res.text, expand).toContain('expand: at most one level.');
    }
    for (const expand of ['related', 'reviews', 'foo', 'constructor']) {
      expect((await exp(agent, 'divine', `expand=${expand}`)).status, expand).toBe(400);
    }
    expect(json(await exp(agent, 'divine', 'limit=100&expand=product'))).toMatchObject({ rows: 100, cost: 100, returned: 20 });
    expect(json(await exp(agent, 'divine', 'limit=100&expand=product')).flag).toBeUndefined();
  });

  it('pages by cursor through the ledger: next walks forward, and the last page has none', async () => {
    const { agent } = await freshSession();
    let cursor: string | null = cursorOf(TOTAL_ROWS - 150);
    const seen: number[] = [];
    for (let i = 0; i < 5 && cursor !== null; i++) {
      const j = json(await exp(agent, 'divine', `limit=100&cursor=${cursor}`));
      seen.push(j.rows);
      cursor = j.next;
    }
    expect(seen).toEqual([100, 50]);
    expect(cursor).toBeNull();
  });

  it('the cost budget of 10 000 answers 413 (reachable only by raising the fan-out, a test seam)', async () => {
    const { agent } = await freshSession();
    expect(divine.overBudget(10_000)).toBeUndefined();
    expect(divine.overBudget(10_001)).toMatch(/budget/i);
    const before = FANOUT.product;
    FANOUT.product = 1000; // 100 rows x 1000 = 100 000 > 10 000
    try {
      const res = await exp(agent, 'divine', 'limit=100&expand=product');
      expect(res.status).toBe(413);
      expect(res.text).not.toMatch(FLAG_RE);
      expect((await exp(agent, 'divine', 'limit=5&expand=product')).status).toBe(200); // 5 x 1000 = 5000: inside the budget
    } finally {
      FANOUT.product = before;
    }
    expect(FANOUT.product).toBe(1);
  });
});

describe('RM-12 every level', () => {
  it('a parameter given twice, an invalid cursor or one past the ledger is a 400, with no flag', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const qs of ['limit=1&limit=2', 'expand=product&expand=product', 'cursor=a&cursor=b', 'cursor=!!!', 'cursor=', `cursor=${cursorOf(TOTAL_ROWS + 1)}`, `cursor=${Buffer.from('-5').toString('base64url')}`, `cursor=${Buffer.from('1.5').toString('base64url')}`]) {
        const res = await exp(agent, level, qs);
        expect(res.status, `${level} ${qs}`).toBe(400);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('the JSON has exactly rows, cost, returned, next, data and note (and a flag only below divine, on proof)', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const j = json(await exp(agent, level, 'limit=5&expand=product'));
      expect(Object.keys(j), level).toEqual(['rows', 'cost', 'returned', 'next', 'data', 'note']);
      expect(j.note, level).toBe('Nothing was truncated: the preview is the whole answer.');
    }
  });

  it('the landing page answers 200, lists the endpoint with an example that works, and has no Restart', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      const res = await agent.get(`${LAB}?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.text, level).toContain('/api/export?limit=&amp;cursor=&amp;expand=');
      const href = /<a href="([^"]*api\/export[^"]*)">/.exec(res.text)?.[1].replace(/&amp;/g, '&') ?? '';
      expect(href, level).toContain(`level=${level}`);
      expect((await agent.get(href)).status, level).toBe(200);
      expect((await agent.post(`${LAB}/_reset?level=${level}`)).status, level).toBe(404);
    }
  });

  it('the Try it form renders the same JSON, escaped, in a pre block, and mirrors the status', async () => {
    const { agent } = await freshSession();
    const ok = await agent.post(`${LAB}?level=acolyte`).type('form').send({ intent: 'export', limit: '1000000', expand: '' });
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(/<pre[^>]*>[\s\S]*&#34;rows&#34;: ?1000000/);
    expect(ok.text).toMatch(FLAG_RE);
    const refused = await agent.post(`${LAB}/export?level=divine`).type('form').send({ limit: '0' });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('limit must be between 1 and 100.');
    expect(refused.text).not.toMatch(FLAG_RE);
  });
});
