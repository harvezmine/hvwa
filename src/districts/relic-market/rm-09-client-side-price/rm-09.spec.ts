// src/districts/relic-market/rm-09-client-side-price/rm-09.spec.ts
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { cartOf, describeShopBasics, ordersOf, productForm, shopClient, walletOf, type ShopCtx } from '../_shared/shop-lab.testkit.js';
import { RM09 } from './challenge.js'; // registers RM-09 before createApp() inside freshSession
import { PRICE_LISTS, labState } from './model.js';

const LAB = '/d/relic-market/client-side-price';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const shop = shopClient(LAB);
const { checkout, form, home, ctx, restart } = shop;
/** POST <lab>/cart with exactly these fields (what a script or a devtools edit sends). */
const add = (c: Ctx, body: Record<string, string>) => shop.post(c, '/cart', body);
/** Add a product the way the browser does: with its own form's fields (the level's hidden ones included). */
const addWithOwnForm = async (c: Ctx, sku: string, qty = '1') => {
  const fields = productForm((await home(c)).text, sku);
  return form(c, { ...fields, qty });
};

// Acolyte: the server charges the hidden price field.
const acolyteExploit: Script = async (c) => { await add(c, { sku: 'RELIQUARY', qty: '1', price: '100' }); return checkout(c); };
// Templar: the checksum has no secret, so anyone can compute it for their own price.
const templarExploit: Script = async (c) => {
  await add(c, { sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('RELIQUARY:100') });
  return checkout(c);
};
// Inquisitor: the server prices from whichever list the client names.
const inquisitorExploit: Script = async (c) => { await add(c, { sku: 'RELIQUARY', qty: '1', price_list: 'staff' }); return checkout(c); };

describeExploitMatrix<Script>({
  challenge: RM09,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Insufficient funds: the total is $500.00 and your wallet holds $25.00.',
  legit: [{
    name: 'buy a votive candle with the form\'s own hidden fields',
    input: async (c) => { await addWithOwnForm(c, 'CANDLE'); return form(c, { intent: 'checkout' }); },
    expect: 'Order #1 placed',
  }],
  malformed: [],
  privileged: null,
});

describeShopBasics({ challenge: RM09, path: LAB, labState, hasRestart: true });

describeLabView({
  challenge: RM09,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'qty',
  extra: { intent: 'add', sku: 'CANDLE', price: '250', price_list: 'retail' },
  oddBodies: [
    { intent: 'add', sku: 'CANDLE', qty: '1', price: { a: 1 }, sig: ['x'], price_list: { staff: 1 } },
    { intent: ['add'], sku: { a: 1 } }, { intent: 'checkout', x: [1] }, [],
  ],
  ok: (agent, level, sid) => addWithOwnForm({ agent, level, sid }, 'CANDLE'),
  bad: (agent, level, sid) => add({ agent, level, sid }, { sku: 'GRAIL', qty: '1' }),
});

const candleFields: Record<Level, readonly string[]> = {
  acolyte: ['price=250'],
  templar: ['price=250', `sig=${sha256hex('CANDLE:250')}`],
  inquisitor: ['price_list=retail'],
  divine: [],
};
describeCurlExample({ challenge: RM09, path: LAB, curl: (level) => ({ path: '/cart', form: ['sku=CANDLE', 'qty=1', ...candleFields[level]] }) });

describe('RM-09 client-side price', () => {
  it('each level\'s add-to-cart form carries its hidden fields verbatim (devtools shows them)', async () => {
    const want: Record<Level, Record<string, string>> = {
      acolyte: { price: '50000' },
      templar: { price: '50000', sig: sha256hex('RELIQUARY:50000') },
      inquisitor: { price_list: 'retail' },
      divine: {},
    };
    for (const level of LEVELS) {
      const html = (await home(await ctx(level))).text;
      expect(productForm(html, 'RELIQUARY'), level).toEqual({ intent: 'add', sku: 'RELIQUARY', ...want[level], qty: '1' });
      for (const [name, value] of Object.entries(want[level])) {
        expect(html, level).toContain(`<input type="hidden" name="${name}" value="${value}">`);
      }
    }
  });

  it('acolyte: the server charges whatever safe integer the price field says, and only refuses the rest', async () => {
    const c = await ctx('acolyte');
    expect(cartOf((await add(c, { sku: 'RELIQUARY', qty: '2', price: '1' })).text)).toEqual([{ sku: 'RELIQUARY', qty: 2, line: 2, kind: '' }]);
    for (const price of ['', 'abc', '9007199254740992', '9'.repeat(400)]) {
      expect((await add(c, { sku: 'CANDLE', qty: '1', price })).text, price).toContain('Invalid price.');
    }
    await add(c, { sku: 'CANDLE', qty: '1', price: '-5000' });
    const res = await checkout(c);
    expect(res.text).toContain('The order total cannot be negative.'); // plumbing, every level: a price lesson, not a credit one
    expect(ordersOf(res.text)).toEqual([]);
  });

  it('templar: a missing, wrong or borrowed checksum is tampering; a recomputed one is accepted', async () => {
    const c = await ctx('templar');
    const tampered: Record<string, string>[] = [
      { sku: 'RELIQUARY', qty: '1', price: '100' },
      { sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('RELIQUARY:50000') },
      { sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('CANDLE:100') },
    ];
    for (const body of tampered) {
      expect((await add(c, body)).text, JSON.stringify(body)).toContain('Tampering detected: the price checksum does not match.');
    }
    expect(cartOf((await home(c)).text)).toEqual([]);
    const res = await add(c, { sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('RELIQUARY:100') });
    expect(cartOf(res.text)).toEqual([{ sku: 'RELIQUARY', qty: 1, line: 100, kind: '' }]);
  });

  it('inquisitor: client prices are ignored, but any named price list is honoured (partner too)', async () => {
    const c = await ctx('inquisitor');
    const res = await add(c, { sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('RELIQUARY:100') });
    expect(cartOf(res.text)).toEqual([{ sku: 'RELIQUARY', qty: 1, line: 50000, kind: '' }]);
    expect((await add(c, { sku: 'CANDLE', qty: '1', price_list: 'wholesale' })).text).toContain('Unknown price list.');
    expect((await add(c, { sku: 'CANDLE', qty: '1', price_list: 'constructor' })).text).toContain('Unknown price list.');
    const nested = await c.agent.post(`${LAB}/cart?level=inquisitor`).type('form').send('sku=CANDLE&qty=1&price_list[]=staff');
    expect(cartOf(nested.text)).toContainEqual({ sku: 'CANDLE', qty: 1, line: 250, kind: '' }); // not a string: retail
    await add(c, { sku: 'RELIQUARY', qty: '0' }); // not a quantity: refused, the line stays
    const partner = await add(c, { sku: 'CANDLE', qty: '1', price_list: 'partner' });
    expect(cartOf(partner.text)).toContainEqual({ sku: 'CANDLE', qty: 1, line: 150, kind: '' });
  });

  it('divine: no price-related field reaches the price; the account\'s list (retail) is used', async () => {
    const c = await ctx('divine');
    const res = await add(c, {
      sku: 'RELIQUARY', qty: '1', price: '100', sig: sha256hex('RELIQUARY:100'), price_list: 'staff', unitPrice: '1',
    });
    expect(cartOf(res.text)).toEqual([{ sku: 'RELIQUARY', qty: 1, line: 50000, kind: '' }]);
    expect(labState(c.sid, 'divine').account).toEqual({ customer: 'C-1042', priceList: 'retail' });
  });

  it('the proof reads the order: a line charged below its list price, and the flag stays on the order row', async () => {
    const c = await ctx('acolyte');
    const res = await acolyteExploit(c);
    const [order] = ordersOf(res.text);
    expect(order).toMatchObject({ no: 1, total: 100, charged: 100, status: 'paid' });
    expect(order.flag).toMatch(FLAG_RE);
    expect(labState(c.sid, 'acolyte').orders[0].lines[0]).toMatchObject({ sku: 'RELIQUARY', unitPrice: 100, listPrice: 50000 });
    await addWithOwnForm(c, 'CANDLE');
    const later = await checkout(c);
    expect(ordersOf(later.text).map((o) => o.flag)).toEqual([undefined, order.flag]);
    expect(walletOf(later.text)).toBe(2500 - 100 - 250);
  });

  it('GET /api/price-lists is public JSON at every level: every list, its percentage and its prices', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const res = await c.agent.get(`${LAB}/api/price-lists?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/application\/json/);
      expect(res.body.lists.map((l: { name: string; percent: number }) => [l.name, l.percent]), level)
        .toEqual([['retail', 100], ['partner', 60], ['staff', 1]]);
      expect(res.body.lists[2].prices, level).toEqual({ RELIQUARY: 500, CHALICE: 40, CANDLE: 2 });
      expect((await home(c)).text, level).toContain(`href="${LAB}/api/price-lists?level=${level}"`);
    }
    expect(PRICE_LISTS.map((l) => l.name)).toEqual(['retail', 'partner', 'staff']);
  });

  it('every level: quantities are 1 to 99 (not this lab\'s lesson) and only catalog SKUs reach the cart', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const fields = productForm((await home(c)).text, 'CANDLE');
      for (const qty of ['-1', '0', '100', ' 1', '1.5', '']) {
        expect((await add(c, { ...fields, qty })).text, `${level} ${JSON.stringify(qty)}`).toContain('Quantity must be a whole number from 1 to 99.');
      }
      for (const sku of ['GRAIL', 'constructor', 'candle']) {
        expect((await add(c, { ...fields, sku })).text, `${level} ${sku}`).toContain('Unknown product.');
      }
      expect((await checkout(c)).text, level).toContain('Your cart is empty.');
    }
  });

  it('Restart: a spent wallet starts over, and the flag can still be earned afterwards', async () => {
    const c = await ctx('templar');
    await templarExploit(c);
    expect(walletOf((await home(c)).text)).toBe(2400);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(2500);
    expect(ordersOf(fresh)).toEqual([]);
    const flag = ordersOf((await templarExploit(c)).text)[0].flag;
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-09', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'templar' });
  });
});
