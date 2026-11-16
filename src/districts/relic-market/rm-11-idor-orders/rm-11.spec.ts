// src/districts/relic-market/rm-11-idor-orders/rm-11.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { orderIdsOf, shopClient, type ShopCtx } from '../_shared/shop-lab.testkit.js';
import { RM11 } from './challenge.js'; // registers RM-11 before createApp() inside freshSession
import { idsFor, labState } from './model.js';

const LAB = '/d/relic-market/idor-orders';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { ctx, home, form } = shop;
const page = (c: Ctx, id: string) => c.agent.get(`${LAB}/orders/${encodeURIComponent(id)}?level=${c.level}`);
const api = (c: Ctx, id: string) => c.agent.get(`${LAB}/api/orders/${encodeURIComponent(id)}?level=${c.level}`);
const batch = (c: Ctx, ids: readonly string[]) => c.agent.get(`${LAB}/api/orders?level=${c.level}&ids=${ids.map(encodeURIComponent).join(',')}`);
const find = (c: Ctx, id: string) => form(c, { intent: 'find', id });
const own = (c: Ctx) => idsFor(c.sid, c.level).own;
/**
 * Where the exploits are pointed: Sister Maren's REAL order id at the served level (test seam), so an exploit is also
 * fired at the levels that hide or randomize it (step-up, Divine): they must refuse on ownership, not merely because
 * "1002" is no id there. How a player FINDS that id at each level has its own cases below.
 */
const victim = (c: Ctx): string => idsFor(c.sid, c.level).victim;

// Acolyte: sequential ids and no ownership check: Maren's order is the next number after yours.
const acolyteExploit: Script = async (c) => page(c, '1002');
// Templar: the ids are only base64url-encoded, and nothing checks ownership anyway: encode the next number. Where
// that guess is no id (Inquisitor and Divine use random ids), aim at the real one, so the ownership check is what
// refuses it there, not just a wrong guess.
const templarExploit: Script = async (c) => {
  const guess = await page(c, Buffer.from('1002').toString('base64url'));
  return guess.status === 404 ? page(c, victim(c)) : guess;
};
// Inquisitor: random ids and ownership checks on both single doors; the batch door checks only the first id, and the
// "recently shipped" feed leaks Maren's id.
const inquisitorExploit: Script = async (c) => batch(c, [own(c)[0], victim(c)]);

describeExploitMatrix<Script>({
  challenge: RM11,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Order not found.',
  resistedStatus: 404, // Divine answers an order that is not yours exactly like one that does not exist
  legit: [
    { name: 'own order page', input: async (c) => page(c, own(c)[0]), expect: 'Votive Candle' },
    { name: 'own order through the API', input: async (c) => api(c, own(c)[1]), expect: 'Pilgrim' },
    { name: 'a batch of own orders', input: async (c) => batch(c, own(c)), expect: 'Votive Candle' },
    { name: 'find own order', input: async (c) => find(c, own(c)[0]), expect: 'Votive Candle' },
  ],
  malformed: [],
  privileged: null, // nobody signs in as another customer: the lab has no privileged identity to replay
});

describeLabView({
  challenge: RM11,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'id',
  extra: { intent: 'find' },
  oddBodies: [
    { intent: 'find', id: { a: 1 } }, { intent: 'find', id: ['1001', '1002'] }, { intent: ['find'], id: '1001' },
    { intent: { a: 1 } }, [],
  ],
  ok: (agent, level, sid) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'find', id: idsFor(sid, level).own[0] }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'find', id: 'no-such-order' }),
});

describeCurlExample({ challenge: RM11, path: LAB, curl: () => ({ path: '/api/orders/<your order id>' }) });

const DENIED = 'Forbidden: this order belongs to another customer.';
const CROCKFORD = /^ORD-[0-9A-HJKMNP-TV-Z]{10}$/;
const GIFT = 'For Brother Anselm: the vault seal rests under the third lantern.';

describe('RM-11 ids', () => {
  it('acolyte: sequential numbers (yours 1001 and 1003, Maren 1002, Tobias 1004), the same for every player', async () => {
    const c = await ctx('acolyte');
    expect(idsFor(c.sid, 'acolyte')).toMatchObject({ own: ['1001', '1003'], victim: '1002' });
    const d = await ctx('acolyte');
    expect(idsFor(d.sid, 'acolyte')).toEqual(idsFor(c.sid, 'acolyte'));
  });

  it('templar: the same numbers, base64url-encoded (MTAwMQ is 1001)', async () => {
    const c = await ctx('templar');
    expect(idsFor(c.sid, 'templar')).toMatchObject({ own: ['MTAwMQ', 'MTAwMw'], victim: 'MTAwMg' });
    expect(Buffer.from(idsFor(c.sid, 'templar').victim, 'base64url').toString()).toBe('1002');
  });

  it('inquisitor and divine: ORD- and ten Crockford base32 characters, drawn per player, never the number', async () => {
    for (const level of ['inquisitor', 'divine'] as const) {
      const a = await ctx(level);
      const b = await ctx(level);
      const ids = idsFor(a.sid, level);
      for (const id of [...ids.own, ids.victim, ids.tobias]) expect(id, level).toMatch(CROCKFORD);
      expect(new Set([...ids.own, ids.victim, ids.tobias]).size, level).toBe(4);
      expect(idsFor(b.sid, level).victim, level).not.toBe(ids.victim);
    }
  });

  it('the seeded orders of other customers live in the pinned store, never in the player\'s own list', async () => {
    const c = await ctx('acolyte');
    await home(c);
    const state = labState(c.sid, 'acolyte');
    expect(state.pinned.map((o) => o.owner)).toEqual(['C-1042', 'C-1043', 'C-1042', 'C-1044']);
    expect(state.orders).toEqual([]);
  });
});

describe('RM-11 acolyte and templar: the realistic way in', () => {
  it('acolyte: GET /orders/1002 shows Maren\'s order, Bandung and the gift message, with the flag line', async () => {
    const c = await ctx('acolyte');
    const res = await c.agent.get(`${LAB}/orders/1002?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Silver Chalice');
    expect(res.text).toContain('Bandung');
    expect(res.text).toContain(GIFT);
    expect(res.text).toMatch(FLAG_RE);
  });

  it('acolyte: the API and the Find form serve it too; the API shows the flag as a JSON field', async () => {
    const c = await ctx('acolyte');
    const j = (await c.agent.get(`${LAB}/api/orders/1002?level=acolyte`)).body as Record<string, unknown>;
    expect(j).toMatchObject({ id: '1002', customer: 'C-1043', city: 'Bandung', gift: GIFT });
    expect(String(j.flag)).toMatch(/^HVWA\{[0-9a-f]{32}\}$/);
    expect((await find(c, '1002')).text).toMatch(FLAG_RE);
  });

  it('acolyte: a batch returns everything it is asked for (Maren and Tobias too)', async () => {
    const c = await ctx('acolyte');
    const j = (await batch(c, ['1001', '1002', '1004'])).body as { orders: { id: string }[]; flag?: string };
    expect(j.orders.map((o) => o.id)).toEqual(['1001', '1002', '1004']);
    expect(j.flag).toMatch(/^HVWA\{/);
  });

  it('templar: the encoded id works, the plain number is no id there, and the encoding is no check', async () => {
    const c = await ctx('templar');
    const res = await c.agent.get(`${LAB}/orders/MTAwMg?level=templar`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(GIFT);
    expect(res.text).toMatch(FLAG_RE);
    const plain = await c.agent.get(`${LAB}/orders/1002?level=templar`);
    expect(plain.status).toBe(404);
    expect(plain.text).not.toMatch(FLAG_RE);
    expect(String(((await api(c, 'MTAwMg')).body as { flag?: string }).flag)).toMatch(/^HVWA\{/);
  });

  it('own orders never carry a flag, at any level, on any door', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      for (const res of [await page(c, own(c)[0]), await api(c, own(c)[0]), await batch(c, own(c)), await find(c, own(c)[1])]) {
        expect(res.status, level).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('RM-11 inquisitor', () => {
  it('both single doors and the Find form refuse Maren\'s order with 403 and no flag', async () => {
    const c = await ctx('inquisitor');
    for (const res of [await page(c, victim(c)), await api(c, victim(c)), await find(c, victim(c))]) {
      expect(res.status).toBe(403);
      expect(res.text).toContain(DENIED);
      expect(res.text).not.toMatch(FLAG_RE);
      expect(res.text).not.toContain(GIFT);
    }
  });

  it('the "recently shipped" feed leaks Maren\'s id, and that id is what the batch door needs', async () => {
    const c = await ctx('inquisitor');
    const feed = /<section[^>]*data-testid="feed"[\s\S]*?<\/section>/.exec((await home(c)).text)?.[0] ?? '';
    const printed = /Bandung[^<]*<code>(ORD-[0-9A-Z]{10})<\/code>/.exec(feed)?.[1];
    expect(printed).toBe(victim(c));
    const res = await batch(c, [own(c)[0], printed ?? 'unknown']);
    expect(res.status).toBe(200);
    expect(res.text).toContain(GIFT);
    expect(res.text).toMatch(FLAG_RE);
  });

  it('the batch checks only the FIRST id: [victim, own] and [victim] are denied (403), [own, victim] is not', async () => {
    const c = await ctx('inquisitor');
    for (const ids of [[victim(c), own(c)[0]], [victim(c)], [idsFor(c.sid, 'inquisitor').tobias]]) {
      const res = await batch(c, ids);
      expect(res.status, ids.join()).toBe(403);
      expect(res.text).toContain(DENIED);
      expect(res.text).not.toMatch(FLAG_RE);
    }
    expect((await batch(c, [own(c)[1], victim(c)])).status).toBe(200);
  });
});

describe('RM-11 divine', () => {
  it('the feed prints a city and an item for every order, but no order id at all', async () => {
    const c = await ctx('divine');
    const html = (await home(c)).text;
    const ids = idsFor(c.sid, 'divine');
    const feed = /<section[^>]*data-testid="feed"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(feed).not.toMatch(/ORD-|order <code>/);
    for (const id of [...ids.own, ids.victim, ids.tobias]) expect(feed, id).not.toContain(id);
    for (const city of ['Jakarta', 'Bandung', 'Medan']) expect(feed).toContain(city);
    expect(feed).toContain('Silver Chalice');
    for (const id of [ids.victim, ids.tobias]) expect(html, id).not.toContain(id); // nor anywhere else on the page
  });

  it('a foreign order, an unknown id and a batch with either are one and the same 404 with the same body', async () => {
    const c = await ctx('divine');
    const ids = idsFor(c.sid, 'divine');
    const unknown = await page(c, 'ORD-0000000000');
    expect(unknown.status).toBe(404);
    for (const res of [await page(c, ids.victim), await page(c, ids.tobias)]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(unknown.text);
    }
    const apiUnknown = await api(c, 'ORD-0000000000');
    expect((await api(c, ids.victim)).text).toBe(apiUnknown.text);
    expect(apiUnknown.status).toBe(404);
    const batchUnknown = await batch(c, [ids.own[0], 'ORD-0000000000']);
    for (const res of [batchUnknown, await batch(c, [ids.own[0], ids.victim]), await batch(c, [ids.victim, ids.own[0]]), await batch(c, [ids.victim])]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(batchUnknown.text);
      expect(res.text).not.toMatch(FLAG_RE);
    }
    expect((await find(c, ids.victim)).status).toBe(404);
  });

  it('own orders are served, and a header claiming to be someone else changes nothing', async () => {
    const c = await ctx('divine');
    const res = await c.agent.get(`${LAB}/api/orders/${victim(c)}?level=divine`).set('X-User-Id', 'C-1043').set('X-Customer', 'C-1043');
    expect(res.status).toBe(404);
    expect((await batch(c, own(c))).status).toBe(200);
  });
});

describe('RM-11 batch door limits and odd ids', () => {
  it('ids must be given once as a list of 1 to 10: repeated, empty, missing or 11 is a 400 at every level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const [a, b] = own(c);
      const get = (q: string) => c.agent.get(`${LAB}/api/orders?level=${level}${q}`);
      for (const q of [`&ids=${a}&ids=${b}`, '&ids=', '', `&ids[]=${a}`, '&ids[x]=1']) {
        const res = await get(q);
        expect(res.status, `${level} ${q}`).toBe(400);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
      const eleven = Array.from({ length: 11 }, (_, i) => `x${i}`).join(',');
      expect((await get(`&ids=${eleven}`)).status, level).toBe(400);
      const ten = Array.from({ length: 10 }, (_, i) => `x${i}`).join(',');
      expect((await get(`&ids=${a},${ten.split(',').slice(0, 9).join(',')}`)).status, level).toBe(level === 'divine' ? 404 : 200);
    }
  });

  it('strange ids are a 404 (never a 500, never a flag), on every door and at every level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      for (const id of ['__proto__', 'constructor', 'toString', '%00', 'x'.repeat(3000), '-1', '1.5', '1001 ', ' 1001']) {
        for (const res of [await page(c, id), await api(c, id), await batch(c, [id, id])]) {
          expect([403, 404], `${level} ${id.slice(0, 10)}`).toContain(res.status);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
    }
  });

  it('a batch of ten orders at acolyte answers a small JSON (the response is bounded by the 10 ids)', async () => {
    const c = await ctx('acolyte');
    const ids = ['1001', '1002', '1003', '1004', '1001', '1002', '1003', '1004', '1001', '1002'];
    const res = await batch(c, ids);
    expect(res.status).toBe(200);
    expect(res.text.length).toBeLessThan(8000);
  });
});

describe('RM-11 page', () => {
  it('your orders lists only your own two (newest first), with links; other customers\' orders never appear there', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const html = (await home(c)).text;
      const [a, b] = own(c);
      expect(orderIdsOf(html), level).toEqual([b, a]);
      for (const id of [a, b]) expect(html, level).toContain(`href="${LAB}/orders/${id}?level=${level}"`);
      const mine = /<ul class="shop-orders">[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
      expect(mine, level).not.toContain('Silver Chalice');
      expect(mine, level).not.toContain(victim(c));
    }
  });

  it('the API box lists the single and the batch endpoints, each with a working example link', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const html = (await home(c)).text;
      const links = [...html.matchAll(/<li><code>GET <a href="([^"]*)">([^<]*)<\/a><\/code>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, '&'), name: m[2] }));
      expect(links.map((l) => l.name), level).toEqual(['/api/orders/:id', '/api/orders?ids=a,b']);
      for (const l of links) {
        expect(l.href, level).not.toContain(':id');
        const res = await c.agent.get(l.href);
        expect(res.status, `${level} ${l.href}`).toBe(200);
      }
    }
  });

  it('there is no Restart (POST <lab>/_reset is 404), and the page answers 200 at every level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      expect((await home(c)).status, level).toBe(200);
      expect((await c.agent.post(`${LAB}/_reset?level=${level}`)).status, level).toBe(404);
    }
  });

  it('the lab is read-only and per player: another session at the same level has its own ids at inquisitor', async () => {
    const a = await ctx('inquisitor');
    const b = await ctx('inquisitor');
    expect((await page(b, victim(a))).status).toBe(404);
    expect((await page(b, own(b)[0])).status).toBe(200);
  });

  it('an order id typed into Find is kept in the field, escaped', async () => {
    const c = await ctx('acolyte');
    const res = await find(c, '"><i>');
    expect(res.status).toBe(404);
    expect(res.text).toContain('value="&#34;&gt;&lt;i&gt;"');
    expect(res.text).not.toContain('<i>');
  });
});

// Keep `Level` in use for readers: the per-level table of what the feed shows.
const FEED_SHOWS_IDS: Record<Level, boolean> = { acolyte: true, templar: true, inquisitor: true, divine: false };
describe('RM-11 feed', () => {
  it('prints order ids below Divine only', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const html = (await home(c)).text;
      const feed = /<section[^>]*data-testid="feed"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      expect(feed, level).toContain('Bandung');
      expect(feed.includes(`<code>${victim(c)}</code>`), level).toBe(FEED_SHOWS_IDS[level]);
    }
  });
});
