// src/districts/relic-market/rm-14-cart-total-overflow/rm-14.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { exactValue } from '../_shared/shop.js';
import { cartOf, describeShopBasics, endpointsShown, ordersOf, shopClient, walletOf, type ShopCtx } from '../_shared/shop-lab.testkit.js';
import { RM14 } from './challenge.js'; // registers RM-14 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/relic-market/cart-total-overflow';
const INT32_MAX = 2_147_483_647;
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { add, checkout, form, home, ctx, restart } = shop;
const cartTotal = (html: string) => Number(/data-testid="cart-total" data-cents="(-?\d+)"/.exec(html)?.[1]);

// Acolyte: Math.imul(999900, 3000) wraps to -1 295 267 296, which is "affordable" and credits the wallet.
const acolyteExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await add(c, 'RELIQUARY', '3000'); return checkout(c); };
// Templar: totals must be positive, but 4293967496 | 0 is -999 800, so the reliquary lands at $1.00.
const templarExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await add(c, 'SLIP', '4293967496'); return checkout(c); };
// Inquisitor: every line fits in INT32, but the sum is 2^32 + 100 and wraps to $1.00.
const INQUISITOR_CART: readonly (readonly [string, string])[] = [
  ['ALTAR', '107'], ['THRONE', '143'], ['RELIQUARY', '1'], ['CHALICE', '71'], ['CANDLE', '370'], ['SLIP', '246'],
];
const inquisitorExploit: Script = async (c) => {
  for (const [sku, qty] of INQUISITOR_CART) await add(c, sku, qty);
  return checkout(c);
};

describeExploitMatrix<Script>({
  challenge: RM14,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: {
    acolyte: 'Insufficient funds: the total is $9,999.00 and your wallet holds $50.00.',
    templar: 'Insufficient funds: the total is $9,999.00 and your wallet holds $50.00.',
    inquisitor: 'Insufficient funds: the total is $98,749.00 and your wallet holds $50.00.', // reliquary + 71 chalices
  },
  legit: [{
    name: 'buy 2 votive candles',
    input: async (c) => { await form(c, { intent: 'add', sku: 'CANDLE', qty: '2' }); return form(c, { intent: 'checkout' }); },
    expect: 'Order #1 placed',
  }],
  malformed: [],
  privileged: null,
});

describeShopBasics({ challenge: RM14, path: LAB, labState, hasRestart: true });

describeLabView({
  challenge: RM14,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'qty',
  extra: { intent: 'add', sku: 'CANDLE' },
  oddBodies: [{ intent: 'add', sku: 'SLIP', qty: ['4293967496'] }, { intent: ['add'], sku: { a: 1 } }, { intent: 'checkout', n: [1] }, []],
  ok: (agent, level, sid) => form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: '1' }),
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: 'x' }),
});

describeCurlExample({ challenge: RM14, path: LAB, curl: () => ({ path: '/cart', form: ['sku=SLIP', 'qty=1'] }) });

describe('RM-14 integer overflow in cart total', () => {
  it('every level: the page lists each endpoint with its fields, and the curl note needs no sign-in', async () => {
    for (const level of LEVELS) {
      const html = (await home(await ctx(level))).text;
      expect(endpointsShown(html), level).toEqual([
        `POST ${LAB}/cart?level=${level} (sku, qty)`, `POST ${LAB}/cart/remove?level=${level} (sku, kind)`, `POST ${LAB}/checkout?level=${level}`,
      ]);
      expect(html, level).toContain('open this page in your browser, then copy');
      expect(html, level).not.toContain('sign in here first');
    }
  });

  it('a cart line can be removed, and the total is computed again without it', async () => {
    const c = await ctx('inquisitor');
    await add(c, 'ALTAR', '107');
    await add(c, 'CANDLE', '2');
    const res = await shop.post(c, '/cart/remove', { sku: 'ALTAR' });
    expect(res.text).toContain('Removed Golden Altar from your cart.');
    expect(cartOf(res.text)).toEqual([{ sku: 'CANDLE', qty: 2, line: 500, kind: '' }]);
    expect(cartTotal(res.text)).toBe(500);
  });

  it('every level: the cart shows the INT32 range the order service stores cents in', async () => {
    for (const level of LEVELS) {
      expect((await home(await ctx(level))).text, level).toContain('INT32 range: -2,147,483,648 … 2,147,483,647 cents');
    }
  });

  it('acolyte: lines merge by SKU, the line wraps negative, and checkout credits the wallet', async () => {
    const c = await ctx('acolyte');
    await add(c, 'RELIQUARY', '1');
    const res = await add(c, 'RELIQUARY', '3000');
    expect(cartOf(res.text)).toEqual([{ sku: 'RELIQUARY', qty: 3000, line: -1_295_267_296, kind: '' }]);
    expect(res.text).toContain('-$12,952,672.96');
    expect(cartTotal(res.text)).toBe(-1_295_267_296);
    const paid = await checkout(c);
    const [order] = ordersOf(paid.text);
    expect(order).toMatchObject({ no: 1, total: -1_295_267_296, charged: -1_295_267_296, status: 'paid' });
    expect(order.flag).toMatch(FLAG_RE);
    expect(walletOf(paid.text)).toBe(5000 + 1_295_267_296);
  });

  it('templar: a total that is not positive is refused, but a quantity of 4293967496 wraps inside its line', async () => {
    const c = await ctx('templar');
    await add(c, 'RELIQUARY', '3000');
    expect((await checkout(c)).text).toContain('Invalid order total.');
    await add(c, 'RELIQUARY', '1');
    const res = await add(c, 'SLIP', '4293967496');
    expect(cartOf(res.text)).toEqual([
      { sku: 'RELIQUARY', qty: 1, line: 999_900, kind: '' },
      { sku: 'SLIP', qty: 4_293_967_496, line: -999_800, kind: '' },
    ]);
    expect(res.text).toMatch(/× 4293967496<\/td><td>-\$9,998\.00<\/td>/);
    expect(cartTotal(res.text)).toBe(100);
    const paid = await checkout(c);
    expect(walletOf(paid.text)).toBe(4900);
    const order = labState(c.sid, 'templar').orders[0];
    expect(order.charged).toBe(100);
    expect(exactValue(order.lines)).toBe(4_294_967_396n); // beyond 2^32: the proof needs BigInt
    expect(ordersOf(paid.text)[0].flag).toMatch(FLAG_RE);
  });

  it('inquisitor: quantities are 1 to 9999 and a line above INT32_MAX is refused when it is added', async () => {
    const c = await ctx('inquisitor');
    for (const qty of ['0', '-1', '10000', '4293967496', ' 1', '1.5', '']) {
      expect((await add(c, 'SLIP', qty)).text, JSON.stringify(qty)).toContain('Quantity must be a whole number from 1 to 9999.');
    }
    expect((await add(c, 'RELIQUARY', '3000')).text).toContain('Line total too large.');
    expect((await add(c, 'ALTAR', '108')).text).toContain('Line total too large.'); // 2 159 999 892
    expect(cartOf((await home(c)).text)).toEqual([]);
  });

  it('inquisitor: lines that each fit still wrap the sum, on every render and at checkout', async () => {
    const c = await ctx('inquisitor');
    let html = '';
    for (const [sku, qty] of INQUISITOR_CART) html = (await add(c, sku, qty)).text;
    const lines = cartOf(html);
    expect(lines.map((l) => l.sku)).toEqual(INQUISITOR_CART.map(([sku]) => sku));
    for (const l of lines) expect(l.line ?? Infinity, l.sku).toBeLessThanOrEqual(INT32_MAX);
    expect(cartTotal(html)).toBe(100);
    expect(cartTotal((await home(c)).text)).toBe(100);
    const order = labState(c.sid, 'inquisitor');
    expect(exactValue(order.cart.map((l) => ({ qty: l.qty, listPrice: l.unitPrice })))).toBe(2n ** 32n + 100n);
    expect(ordersOf((await checkout(c)).text)[0]).toMatchObject({ charged: 100, status: 'paid' });
  });

  it('divine: quantities 1 to 99, exact totals beyond INT32, and orders above $1,000,000.00 need a quote', async () => {
    const c = await ctx('divine');
    for (const qty of ['0', '100', '3000', '4293967496']) {
      expect((await add(c, 'SLIP', qty)).text, qty).toContain('Quantity must be a whole number from 1 to 99.');
    }
    await add(c, 'ALTAR', '99');
    const big = await add(c, 'THRONE', '99');
    expect(cartTotal(big.text)).toBe(99 * 19_999_999 + 99 * 14_999_999); // 3 464 999 802: shown exactly, no wrap
    expect(big.text).toContain('$34,649,998.02');
    expect((await checkout(c)).text).toContain('Orders above $1,000,000.00 need a quote.');
    await add(c, 'THRONE', '0'); // refused: the line stays
    await restart(c);
    await add(c, 'ALTAR', '6'); // $1,199,999.94
    expect((await checkout(c)).text).toContain('Orders above $1,000,000.00 need a quote.');
    await add(c, 'ALTAR', '5'); // $999,999.95: under the cap, so the wallet decides
    expect((await checkout(c)).text).toContain('Insufficient funds: the total is $999,999.95 and your wallet holds $50.00.');
  });

  it('the proof needs the reliquary: an overflowed order without one is paid, but shows no flag', async () => {
    const c = await ctx('acolyte');
    await add(c, 'ALTAR', '108'); // Math.imul wraps to -2 134 967 404
    const res = await checkout(c);
    const [order] = ordersOf(res.text);
    expect(order).toMatchObject({ charged: -2_134_967_404, status: 'paid' });
    expect(order.flag).toBeUndefined();
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('acolyte: the shell bound caps the quantity, above Templar\'s 4293967496', async () => {
    const c = await ctx('acolyte');
    expect((await add(c, 'SLIP', '10000000000')).text).toContain('Quantity too large for this shop.');
    expect(cartOf((await add(c, 'SLIP', '9999999999')).text)).toEqual([{ sku: 'SLIP', qty: 9_999_999_999, line: 1_410_065_407, kind: '' }]);
    expect((await add(c, 'SLIP', 'x')).text).toContain('Quantity must be at least 1.');
    expect((await add(c, 'SLIP', '0')).text).toContain('Quantity must be at least 1.');
  });

  it('every level: an empty cart is no order, and only catalog SKUs reach the cart', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      expect((await checkout(c)).text, level).toContain('Your cart is empty.');
      for (const sku of ['GRAIL', 'constructor', 'slip']) expect((await add(c, sku, '1')).text, `${level} ${sku}`).toContain('Unknown product.');
    }
  });

  it('Restart: a spent wallet starts over, and the flag can still be earned afterwards', async () => {
    const c = await ctx('inquisitor');
    await inquisitorExploit(c);
    expect(walletOf((await home(c)).text)).toBe(4900);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(5000);
    expect(ordersOf(fresh)).toEqual([]);
    const flag = ordersOf((await inquisitorExploit(c)).text)[0].flag;
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-14', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'inquisitor' });
  });
});
