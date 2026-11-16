// src/districts/relic-market/rm-06-coupon-stacking/rm-06.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { cartOf, describeShopBasics, endpointsShown, ordersOf, shopClient, walletOf, type ShopCtx } from '../_shared/shop-lab.testkit.js';
import { RM06 } from './challenge.js'; // registers RM-06 before createApp() inside freshSession
import { COUPONS, bestSingle, labState, walk } from './model.js';

const LAB = '/d/relic-market/coupon-stacking';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { add, checkout, form, home, ctx, restart } = shop;
const coupon = (c: Ctx, code: string) => shop.post(c, '/cart/coupon', { code });
/** One request carrying several `code` fields, as a browser or curl sends a repeated field. */
const couponRepeated = (c: Ctx, codes: readonly string[]) =>
  c.agent.post(`${LAB}/cart/coupon?level=${c.level}`).type('form').send(codes.map((x) => `code=${encodeURIComponent(x)}`).join('&'));
const couponJson = (c: Ctx, body: unknown) => c.agent.post(`${LAB}/cart/coupon?level=${c.level}`).send(body as object);
/** The payable total the page shows after the promotions (cents). */
const payable = (html: string): number => Number(/data-testid="payable" data-cents="(-?\d+)"/.exec(html)?.[1] ?? NaN);
const promos = (html: string): { code: string; amount: number }[] =>
  [...html.matchAll(/<li data-promo="([^"]*)" data-amount="(\d+)">/g)].map((m) => ({ code: m[1], amount: Number(m[2]) }));
const appliedCodes = (html: string): string[] => promos(html).map((p) => p.code);

// Acolyte: no check at all, so RELIC20 stacks on itself: $100 -> $80 -> $60.
const acolyteExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await coupon(c, 'RELIC20'); await coupon(c, 'RELIC20'); return checkout(c); };
// Templar: only the SAME code twice is refused, so two different codes stack: $100 -> $90 -> $70.
const templarExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await coupon(c, 'WELCOME10'); await coupon(c, 'RELIC20'); return checkout(c); };
// Inquisitor: "is there already one?" is asked once per request, so ONE request with two codes gets both.
const inquisitorExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await couponRepeated(c, ['WELCOME10', 'RELIC20']); return checkout(c); };

describeExploitMatrix<Script>({
  challenge: RM06,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Insufficient funds/,
  legit: [{
    name: 'one WELCOME10 on a votive candle',
    input: async (c) => {
      await form(c, { intent: 'add', sku: 'CANDLE', qty: '1' });
      await form(c, { intent: 'coupon', code: 'WELCOME10' });
      return form(c, { intent: 'checkout' });
    },
    expect: 'Order #1 placed',
  }],
  malformed: [],
  privileged: null,
});

describeShopBasics({ challenge: RM06, path: LAB, labState, hasRestart: true });

describeLabView({
  challenge: RM06,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'code',
  extra: { intent: 'coupon' },
  oddBodies: [
    { intent: 'coupon', code: { a: 1 } }, { intent: 'coupon', code: [{ a: [1] }, 'WELCOME10'] }, { intent: ['coupon'], code: 'WELCOME10' },
    { intent: 'coupon', code: null }, { intent: 'coupon', code: { toString: 1 } }, { intent: 'coupon', code: [{ toString: 1 }] }, { intent: 'coupon', code: [] }, { intent: 'uncoupon', extra: { deep: [1] } }, [],
  ],
  ok: async (agent, level, sid) => {
    await form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: '1' });
    return form({ agent, level, sid }, { intent: 'coupon', code: 'WELCOME10' });
  },
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'coupon', code: 'NOSUCHCODE' }),
});

describeCurlExample({ challenge: RM06, path: LAB, curl: () => ({ path: '/cart/coupon', form: ['code=WELCOME10'] }) });

describe('RM-06 discount math (exact integer cents)', () => {
  it('a percentage takes floor(running x pct / 100) of the running total, in the order applied', () => {
    expect(walk(10000, ['WELCOME10', 'RELIC20'])).toEqual({ steps: [{ code: 'WELCOME10', amount: 1000 }, { code: 'RELIC20', amount: 2000 }], total: 7000 });
    expect(walk(10000, ['RELIC20', 'WELCOME10'])).toEqual({ steps: [{ code: 'RELIC20', amount: 2000 }, { code: 'WELCOME10', amount: 800 }], total: 7200 });
    expect(walk(250, ['SPRING15'])).toEqual({ steps: [{ code: 'SPRING15', amount: 37 }], total: 213 }); // floor(37.5)
    expect(walk(250, ['WELCOME10'])).toEqual({ steps: [{ code: 'WELCOME10', amount: 25 }], total: 225 });
    expect(walk(1, ['WELCOME10', 'SPRING15'])).toEqual({ steps: [{ code: 'WELCOME10', amount: 0 }, { code: 'SPRING15', amount: 0 }], total: 1 });
  });

  it('RELIC20 takes $20.00 only while the running total is at least $80.00, and never takes a total below 0', () => {
    expect(walk(8000, ['RELIC20']).total).toBe(6000);
    expect(walk(7999, ['RELIC20'])).toEqual({ steps: [{ code: 'RELIC20', amount: 0 }], total: 7999 });
    expect(walk(10000, ['RELIC20', 'RELIC20', 'RELIC20']).total).toBe(6000); // the third finds 0.00 < the minimum
    expect(walk(8000, ['WELCOME10', 'RELIC20'])).toEqual({ steps: [{ code: 'WELCOME10', amount: 800 }, { code: 'RELIC20', amount: 0 }], total: 7200 });
    for (const subtotal of [0, 1, 99, 250, 7999, 8000, 10000, 123456]) {
      const all = [...COUPONS.keys(), ...COUPONS.keys(), ...COUPONS.keys()];
      const w = walk(subtotal, all);
      expect(w.total, String(subtotal)).toBeGreaterThanOrEqual(0);
      expect(w.total + w.steps.reduce((s, x) => s + x.amount, 0), String(subtotal)).toBe(subtotal);
    }
  });

  it('bestSingle is the largest discount any one promotion gives alone on a list subtotal', () => {
    expect(bestSingle(10000)).toBe(2000);
    expect(bestSingle(7000)).toBe(1050);
    expect(bestSingle(250)).toBe(37);
    expect(bestSingle(0)).toBe(0);
  });
});

describe('RM-06 coupon stacking', () => {
  it('every level: the page lists the promotions, the one-per-order rule and each endpoint; the curl note needs no sign-in', async () => {
    for (const level of LEVELS) {
      const html = (await home(await ctx(level))).text;
      for (const code of ['WELCOME10', 'SPRING15', 'RELIC20']) expect(html, `${level} ${code}`).toContain(`<code>${code}</code>`);
      expect(html, level).toContain('one promotion per order');
      expect(endpointsShown(html), level).toEqual([
        `POST ${LAB}/cart?level=${level} (sku, qty)`, `POST ${LAB}/cart/remove?level=${level} (sku, kind)`,
        `POST ${LAB}/cart/coupon?level=${level} (code)`, `POST ${LAB}/cart/uncoupon?level=${level}`, `POST ${LAB}/checkout?level=${level}`,
      ]);
      expect(html, level).toContain('open this page in your browser, then copy');
    }
  });

  it('acolyte: the exploit is a paid $60.00 order for a $100.00 reliquary, and the flag stays on the order row', async () => {
    const c = await ctx('acolyte');
    const res = await acolyteExploit(c);
    expect(res.text).toContain('Order #1 placed');
    const [order] = ordersOf(res.text);
    expect(order).toMatchObject({ no: 1, total: 6000, charged: 6000, status: 'paid' });
    expect(order.flag).toMatch(FLAG_RE);
    expect(walletOf(res.text)).toBe(1000);
    await add(c, 'CANDLE', '1');
    const later = ordersOf((await checkout(c)).text);
    expect(later.map((o) => o.no)).toEqual([2, 1]);
    expect(later[0].flag).toBeUndefined();
    expect(later[1].flag).toBe(order.flag);
  });

  it('acolyte: any known code is appended, even if it is already applied; each promotion shows its amount', async () => {
    const c = await ctx('acolyte');
    await add(c, 'RELIQUARY', '1');
    await coupon(c, '  welcome10 ');
    await coupon(c, 'WELCOME10');
    const res = await coupon(c, 'RELIC20');
    expect(promos(res.text)).toEqual([{ code: 'WELCOME10', amount: 1000 }, { code: 'WELCOME10', amount: 900 }, { code: 'RELIC20', amount: 2000 }]);
    expect(payable(res.text)).toBe(6100);
  });

  it('every level: an unknown code, a code that is not text and an empty code are refused', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      await add(c, 'CANDLE', '1');
      for (const code of ['NOPE', 'constructor', '__proto__', '', 'WELCOME10,RELIC20']) {
        expect((await coupon(c, code)).text, `${level} ${JSON.stringify(code)}`).toContain('Unknown promotion code.');
      }
      expect((await couponJson(c, { code: { a: 1 } })).text, level).toContain('Unknown promotion code.');
      expect((await couponJson(c, [1, 2])).text, level).toContain('Unknown promotion code.');
      expect(appliedCodes((await home(c)).text), level).toEqual([]);
    }
  });

  it('every level: a code object with its own toString is no code, never a 500', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      await add(c, 'CANDLE', '1');
      const bodies: [string, () => Promise<request.Response>][] = [
        ['json object', () => couponJson(c, { code: { toString: 1 } })],
        ['json array', () => couponJson(c, { code: [{ toString: 1 }] })],
        ['form code[toString]', () => c.agent.post(`${LAB}/cart/coupon?level=${level}`).type('form').send('code[toString]=1')],
        ['page form', () => c.agent.post(`${LAB}?level=${level}`).type('form').send('intent=coupon&code[toString]=1')],
      ];
      for (const [name, send] of bodies) {
        const res = await send();
        expect(res.status, `${level} ${name}`).toBe(200);
        expect(res.text, `${level} ${name}`).toContain('Unknown promotion code.');
      }
    }
  });

  it('acolyte and templar still String() an array: two codes in one request are one unknown code, so only inquisitor has the array flaw', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const c = await ctx(level);
      await add(c, 'RELIQUARY', '1');
      expect((await couponRepeated(c, ['WELCOME10', 'RELIC20'])).text, level).toContain('Unknown promotion code.');
      expect((await couponJson(c, { code: ['WELCOME10', 'RELIC20'] })).text, level).toContain('Unknown promotion code.');
      expect(appliedCodes((await home(c)).text), level).toEqual([]);
    }
  });

  it('templar: the same code twice is refused, different codes stack, and the check ignores case and spaces', async () => {
    const c = await ctx('templar');
    await add(c, 'RELIQUARY', '1');
    expect((await coupon(c, 'WELCOME10')).text).toContain('Promotion WELCOME10 applied.');
    expect((await coupon(c, 'WELCOME10')).text).toContain('This code is already applied.');
    expect((await coupon(c, ' welcome10')).text).toContain('This code is already applied.');
    const res = await coupon(c, 'RELIC20');
    expect(promos(res.text)).toEqual([{ code: 'WELCOME10', amount: 1000 }, { code: 'RELIC20', amount: 2000 }]);
    expect(payable(res.text)).toBe(7000);
  });

  it('inquisitor: the one-per-order rule holds across requests', async () => {
    const c = await ctx('inquisitor');
    await add(c, 'RELIQUARY', '1');
    expect((await coupon(c, 'WELCOME10')).text).toContain('Promotion WELCOME10 applied.');
    for (const code of ['RELIC20', 'WELCOME10', 'SPRING15']) expect((await coupon(c, code)).text, code).toContain('Only one promotion per order.');
    expect((await couponRepeated(c, ['RELIC20', 'SPRING15'])).text).toContain('Only one promotion per order.');
    expect(appliedCodes((await home(c)).text)).toEqual(['WELCOME10']);
  });

  it('inquisitor: one request appends every known, distinct code of a repeated field, a code[] field or a JSON array, at most five read', async () => {
    const cases: [string, (c: Ctx) => Promise<request.Response>][] = [
      ['repeated field', (c) => couponRepeated(c, ['WELCOME10', 'relic20'])],
      ['code[] field', (c) => c.agent.post(`${LAB}/cart/coupon?level=inquisitor`).type('form').send('code[]=WELCOME10&code[]=RELIC20')],
      ['JSON array', (c) => couponJson(c, { code: ['WELCOME10', 'RELIC20'] })],
      ['page form', (c) => c.agent.post(`${LAB}?level=inquisitor`).type('form').send('intent=coupon&code=WELCOME10&code=RELIC20')],
    ];
    for (const [name, send] of cases) {
      const c = await ctx('inquisitor');
      await add(c, 'RELIQUARY', '1');
      const res = await send(c);
      expect(appliedCodes(res.text), name).toEqual(['WELCOME10', 'RELIC20']);
      expect(payable(res.text), name).toBe(7000);
    }
    const c = await ctx('inquisitor');
    await add(c, 'RELIQUARY', '1');
    const res = await couponRepeated(c, ['WELCOME10', 'WELCOME10', 'x', 'y', 'z', 'RELIC20']); // the sixth is never read
    expect(appliedCodes(res.text)).toEqual(['WELCOME10']);
    const none = await ctx('inquisitor');
    expect((await couponRepeated(none, ['x', 'y'])).text).toContain('Unknown promotion code.');
    expect(appliedCodes((await home(none)).text)).toEqual([]);
  });

  it('divine: applying replaces the single slot; a repeated field is no code; the best single promotion is $20.00 on $100.00', async () => {
    const c = await ctx('divine');
    await add(c, 'RELIQUARY', '1');
    await coupon(c, 'WELCOME10');
    const res = await coupon(c, 'RELIC20');
    expect(res.text).toContain('Promotion RELIC20 applied');
    expect(res.text).not.toMatch(FLAG_RE); // a flag is only ever an order row's
    expect(appliedCodes(res.text)).toEqual(['RELIC20']);
    expect(payable(res.text)).toBe(8000);
    expect((await couponRepeated(c, ['WELCOME10', 'SPRING15'])).text).toContain('Unknown promotion code.');
    expect((await couponJson(c, { code: ['WELCOME10'] })).text).toContain('Unknown promotion code.');
    expect(appliedCodes((await home(c)).text)).toEqual(['RELIC20']);
    expect((await checkout(c)).text).toContain('Insufficient funds: the total is $80.00 and your wallet holds $70.00.');
  });

  it('divine: a single promotion that the wallet covers is honoured, and the proof does not hold for it', async () => {
    const c = await ctx('divine');
    await add(c, 'ICON', '2'); // $70.00
    await coupon(c, 'SPRING15'); // -$10.50
    const res = await checkout(c);
    expect(res.text).toContain('Order #1 placed. Charged $59.50');
    expect(ordersOf(res.text)[0].flag).toBeUndefined();
  });

  it('every level: remove promotions clears them, and the promotions are applied against the current cart', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      await add(c, 'RELIQUARY', '1');
      await coupon(c, 'RELIC20');
      const after = await form(c, { intent: 'uncoupon' });
      expect(appliedCodes(after.text), level).toEqual([]);
      expect(payable(after.text), level).toBe(10000);
      await coupon(c, 'RELIC20');
      await form(c, { intent: 'remove', sku: 'RELIQUARY', kind: '' });
      await add(c, 'ICON', '2'); // $70.00: below the $80.00 minimum, so RELIC20 earns nothing
      const res = await home(c);
      expect(promos(res.text), level).toEqual([{ code: 'RELIC20', amount: 0 }]);
      expect(payable(res.text), level).toBe(7000);
    }
  });

  it('a paid order empties the promotions: the next order starts with none', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      await add(c, 'CANDLE', '1');
      await coupon(c, 'SPRING15');
      await checkout(c);
      expect(appliedCodes((await home(c)).text), level).toEqual([]);
      await add(c, 'CANDLE', '1');
      expect(payable((await home(c)).text), level).toBe(250);
    }
  });

  it('checkout: an empty cart is no order, and an exact fit is affordable', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      expect((await checkout(c)).text, level).toContain('Your cart is empty.');
      await add(c, 'ICON', '2'); // $70.00 = the wallet
      const res = await checkout(c);
      expect(res.text, level).toContain('Order #1 placed');
      expect(walletOf(res.text), level).toBe(0);
    }
  });

  it('platform safety: at most 10 promotions on a cart, and quantities are 1 to 99', async () => {
    const c = await ctx('acolyte');
    await add(c, 'CANDLE', '1');
    for (let i = 0; i < 10; i++) expect((await coupon(c, 'WELCOME10')).text).toContain('applied');
    expect((await coupon(c, 'WELCOME10')).text).toContain('Too many promotions on this cart (10).');
    expect(appliedCodes((await home(c)).text)).toHaveLength(10);
    for (const level of LEVELS) {
      const d = await ctx(level);
      for (const qty of ['0', '-1', '100', '1.5', '', 'x']) expect((await add(d, 'CANDLE', qty)).text, `${level} ${qty}`).toContain('Quantity must be a whole number from 1 to 99.');
      expect((await add(d, 'NOPE', '1')).text, level).toContain('Unknown product.');
    }
  });

  it('the proof uses list prices: a discount beyond the best single promotion shows the flag, a smaller one never does', async () => {
    const c = await ctx('acolyte');
    await add(c, 'ICON', '2'); // $70.00: the best single promotion is SPRING15, $10.50
    await coupon(c, 'WELCOME10');
    await coupon(c, 'WELCOME10'); // 700 + 630 = $13.30 > $10.50
    const res = await checkout(c);
    expect(ordersOf(res.text)[0].flag).toMatch(FLAG_RE);
    const d = await ctx('acolyte');
    await add(d, 'ICON', '2');
    await coupon(d, 'SPRING15');
    expect(ordersOf((await checkout(d)).text)[0].flag).toBeUndefined();
    expect(labState(d.sid, 'acolyte').orders[0].subtotal).toBe(7000);
  });

  it('Restart: a spent wallet, the cart, the promotions and the orders start over, and the flag can still be earned', async () => {
    const c = await ctx('acolyte');
    await acolyteExploit(c);
    await add(c, 'CANDLE', '1');
    await coupon(c, 'RELIC20');
    expect(walletOf((await home(c)).text)).toBe(1000);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(7000);
    expect(ordersOf(fresh)).toEqual([]);
    expect(cartOf(fresh)).toEqual([]);
    expect(appliedCodes(fresh)).toEqual([]);
    expect(labState(c.sid, 'acolyte').coupons).toEqual([]);
    const flag = ordersOf((await acolyteExploit(c)).text)[0].flag;
    expect(flag).toMatch(FLAG_RE);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-06', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });
});
