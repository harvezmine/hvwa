// src/districts/relic-market/rm-07-race-coupon-reuse/rm-07.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import type { Gate } from '../_shared/race.js';
import {
  barrierGate, cartOf, describeShopBasics, endpointsShown, ordersOf, shopClient, useFakeClock, useInstantWaits, walletOf, type ShopCtx,
} from '../_shared/shop-lab.testkit.js';
import { RM07 } from './challenge.js'; // registers RM-07 before createApp() inside freshSession
import { VOUCHER, labState } from './model.js';

const LAB = '/d/relic-market/race-coupon-reuse';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { add, checkout, form, home, ctx, restart } = shop;
const voucher = (c: Ctx, code: string) => shop.post(c, '/cart/voucher', { code });
const discountsOf = (html: string): { code: string; amount: number }[] =>
  [...html.matchAll(/<li data-discount="([^"]*)" data-amount="(\d+)">/g)].map((m) => ({ code: m[1], amount: Number(m[2]) }));
const payable = (html: string): number => Number(/data-testid="payable" data-cents="(-?\d+)"/.exec(html)?.[1] ?? NaN);

// Every case except the races runs with instant waits: no test waits real time. The races install a barrier instead.
useInstantWaits();

/**
 * Fire `codes` at the voucher door together and check out. The barrier is installed right before the race (after the
 * set-up requests, which would otherwise count as arrivals) and the race must never need its fallback.
 */
async function race(c: Ctx, codes: readonly string[]): Promise<{ checkout: request.Response; answers: request.Response[] }> {
  const barrier = barrierGate(codes.length);
  labState(c.sid, c.level).gate = barrier.gate;
  const answers = await Promise.all(codes.map((code) => voucher(c, code)));
  expect(barrier.timedOut(), 'the barrier needed its fallback: a request never arrived').toBe(false);
  expect(barrier.arrived()).toBe(codes.length);
  return { checkout: await checkout(c), answers };
}

// Acolyte: check, then the validation pause, then mark: two requests in the pause both pass the check.
const acolyteExploit: Script = async (c) => { await add(c, 'LANTERN', '1'); return (await race(c, ['FIRSTRELIC', 'FIRSTRELIC'])).checkout; };
// Inquisitor: the double-submit guard compares the RAW input, so a different spelling is a different key.
const inquisitorExploit: Script = async (c) => { await add(c, 'LANTERN', '1'); return (await race(c, ['FIRSTRELIC', 'firstrelic'])).checkout; };

describeExploitMatrix<Script>({
  challenge: RM07,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, inquisitor: inquisitorExploit },
  resisted: /Insufficient funds/,
  legit: [{
    name: 'nine candles, FIRSTRELIC once',
    input: async (c) => {
      await form(c, { intent: 'add', sku: 'CANDLE', qty: '9' });
      await form(c, { intent: 'voucher', code: 'FIRSTRELIC' });
      return form(c, { intent: 'checkout' });
    },
    expect: 'Order #1 placed. Charged $7.50',
  }],
  malformed: [],
  privileged: null,
});

describeShopBasics({ challenge: RM07, path: LAB, labState, hasRestart: true });

describeLabView({
  challenge: RM07,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'code',
  extra: { intent: 'voucher' },
  oddBodies: [
    { intent: 'voucher', code: { a: 1 } }, { intent: 'voucher', code: ['FIRSTRELIC', 'FIRSTRELIC'] }, { intent: ['voucher'], code: 'FIRSTRELIC' },
    { intent: 'voucher', code: null }, { intent: 'voucher' }, { intent: 'checkout', extra: { deep: [1] } }, [],
  ],
  ok: async (agent, level, sid) => {
    await form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: '9' });
    return form({ agent, level, sid }, { intent: 'voucher', code: 'FIRSTRELIC' });
  },
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'voucher', code: 'NOSUCHVOUCHER' }),
});

describeCurlExample({ challenge: RM07, path: LAB, curl: () => ({ path: '/cart/voucher', form: ['code=FIRSTRELIC'] }) });

describe('RM-07 race: coupon reuse', () => {
  it('every level: the page explains the pause and the tools, lists each endpoint, and the curl note needs no sign-in', async () => {
    for (const level of RM07.levels) {
      const html = (await home(await ctx(level))).text;
      expect(html, level).toContain('checked with the promotions service; this takes about a second');
      expect(html, level).toContain('Requests that arrive together can interleave.');
      expect(html, level).toContain('Burp Repeater can send a group in parallel');
      expect(html, level).toContain('<code>FIRSTRELIC</code>');
      expect(endpointsShown(html), level).toEqual([
        `POST ${LAB}/cart?level=${level} (sku, qty)`, `POST ${LAB}/cart/remove?level=${level} (sku, kind)`,
        `POST ${LAB}/cart/voucher?level=${level} (code)`, `POST ${LAB}/checkout?level=${level}`,
      ]);
      expect(html, level).toContain('open this page in your browser, then copy');
    }
  });

  it('every level: a second APPLY after the first finished is refused, so the race really is required', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      await add(c, 'LANTERN', '1');
      expect((await voucher(c, 'FIRSTRELIC')).text, level).toContain('Voucher FIRSTRELIC applied.');
      for (const code of ['FIRSTRELIC', 'firstrelic', ' FIRSTRELIC ']) {
        expect((await voucher(c, code)).text, `${level} ${code}`).toContain('This voucher has already been used.');
      }
      const res = await home(c);
      expect(discountsOf(res.text), level).toEqual([{ code: 'FIRSTRELIC', amount: 1500 }]);
      expect(payable(res.text), level).toBe(3500);
      expect((await checkout(c)).text, level).toMatch(/Insufficient funds: the total is \$35\.00 and your wallet holds \$25\.00\./);
    }
  });

  it('acolyte: two parallel applies both pass the check, the order is $20.00 and carries the flag on its row', async () => {
    const c = await ctx('acolyte');
    await add(c, 'LANTERN', '1');
    const { checkout: res, answers } = await race(c, ['FIRSTRELIC', 'FIRSTRELIC']);
    expect(answers.map((a) => a.text.includes('Voucher FIRSTRELIC applied.'))).toEqual([true, true]);
    expect(res.text).toContain('Order #1 placed. Charged $20.00');
    const [order] = ordersOf(res.text);
    expect(order).toMatchObject({ no: 1, total: 2000, charged: 2000, status: 'paid' });
    expect(order.flag).toMatch(FLAG_RE);
    expect(walletOf(res.text)).toBe(500);
    // The proof stays on the order row after the action that made it.
    expect(ordersOf((await home(c)).text)[0].flag).toBe(order.flag);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-07', submission: order.flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('acolyte: the discount lines show in the cart and a total never goes below $0.00', async () => {
    const c = await ctx('acolyte');
    await add(c, 'CANDLE', '8'); // $20.00: exactly the minimum
    const { checkout: res } = await race(c, ['FIRSTRELIC', 'FIRSTRELIC']); // -$30.00 on $20.00
    expect(res.text).toContain('Order #1 placed. Charged $0.00');
    expect(ordersOf(res.text)[0]).toMatchObject({ total: 0, charged: 0 });
    expect(walletOf(res.text)).toBe(2500);
    const d = await ctx('acolyte');
    await add(d, 'LANTERN', '1');
    await race(d, ['FIRSTRELIC', 'FIRSTRELIC']);
    const state = labState(d.sid, 'acolyte');
    expect(state.orders[0].discounts).toEqual([{ code: 'FIRSTRELIC', amount: 1500 }, { code: 'FIRSTRELIC', amount: 1500 }]);
  });

  it('every level: the minimum subtotal is $20.00 (inclusive), and the voucher must be known text', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      expect((await voucher(c, 'FIRSTRELIC')).text, level).toContain('This voucher needs a subtotal of at least $20.00.');
      await add(c, 'CANDLE', '7'); // $17.50
      expect((await voucher(c, 'FIRSTRELIC')).text, level).toContain('This voucher needs a subtotal of at least $20.00.');
      for (const code of ['NOPE', 'constructor', '', 'FIRSTRELIC,FIRSTRELIC']) {
        expect((await voucher(c, code)).text, `${level} ${JSON.stringify(code)}`).toContain('Unknown voucher.');
      }
      expect((await c.agent.post(`${LAB}/cart/voucher?level=${level}`).send({ code: ['FIRSTRELIC'] })).text, level).toContain('Unknown voucher.');
      expect(discountsOf((await home(c)).text), level).toEqual([]);
      await add(c, 'CANDLE', '8'); // exactly $20.00
      expect((await voucher(c, 'FIRSTRELIC')).text, level).toContain('Voucher FIRSTRELIC applied.');
    }
  });

  it('inquisitor: the same raw spelling twice at once is refused, a different spelling is not (and the guard is released afterwards)', async () => {
    const same = await ctx('inquisitor');
    await add(same, 'LANTERN', '1');
    const a = await race(same, ['FIRSTRELIC', 'FIRSTRELIC']);
    expect(a.answers.map((r) => r.text.includes('This voucher is already being applied.')).sort()).toEqual([false, true]);
    expect(discountsOf((await home(same)).text)).toHaveLength(1);
    expect(a.checkout.text).toContain('Insufficient funds');
    expect(labState(same.sid, 'inquisitor').inFlight.size).toBe(0);
    const variants = await ctx('inquisitor');
    await add(variants, 'LANTERN', '1');
    const b = await race(variants, [' FIRSTRELIC', 'firstrelic', 'FirstRelic']);
    expect(b.answers.map((r) => r.text.includes('Voucher FIRSTRELIC applied.'))).toEqual([true, true, true]);
    expect(labState(variants.sid, 'inquisitor').inFlight.size).toBe(0);
    expect(ordersOf(b.checkout.text)[0].flag).toMatch(FLAG_RE);
  });

  it('inquisitor: at most 10 pending requests (a bounded set), and a refused request leaves nothing behind', async () => {
    const c = await ctx('inquisitor');
    await add(c, 'LANTERN', '1');
    const state = labState(c.sid, 'inquisitor');
    for (let i = 0; i < 10; i++) state.inFlight.add(`pending-${i}`);
    expect((await voucher(c, 'FIRSTRELIC')).text).toContain('Too many pending requests.');
    expect(state.inFlight.size).toBe(10);
    state.inFlight.clear();
    expect((await voucher(c, 'NOPE')).text).toContain('Unknown voucher.');
    expect(state.inFlight.size).toBe(0);
    const long = 'x'.repeat(5000);
    await voucher(c, long);
    expect(state.inFlight.size).toBe(0);
  });

  it('divine: under the barrier exactly one of two parallel applies wins, whatever the spelling', async () => {
    for (const codes of [['FIRSTRELIC', 'FIRSTRELIC'], ['FIRSTRELIC', 'firstrelic'], [' FIRSTRELIC', 'FIRSTRELIC ', 'firstRelic']]) {
      const c = await ctx('divine');
      await add(c, 'LANTERN', '1');
      const { checkout: res, answers } = await race(c, codes);
      expect(answers.filter((a) => a.text.includes('Voucher FIRSTRELIC applied.')), codes.join('|')).toHaveLength(1);
      expect(answers.filter((a) => a.text.includes('This voucher has already been used.')), codes.join('|')).toHaveLength(codes.length - 1);
      expect(discountsOf((await home(c)).text), codes.join('|')).toEqual([{ code: 'FIRSTRELIC', amount: 1500 }]);
      expect(res.text).toContain('Insufficient funds: the total is $35.00 and your wallet holds $25.00.');
      for (const a of answers) expect(a.text, 'a flag is only ever an order row').not.toMatch(FLAG_RE);
      expect(res.text).not.toMatch(FLAG_RE);
    }
  });

  it('divine: a validation that fails gives the voucher back, and a second FIRSTRELIC discount is refused even then', async () => {
    const c = await ctx('divine');
    await add(c, 'LANTERN', '1');
    const state = labState(c.sid, 'divine');
    const real = state.gate;
    const broken: Gate = { arrive: () => {}, pass: () => Promise.reject(new Error('promotions service down')) };
    state.gate = broken;
    expect((await voucher(c, 'FIRSTRELIC')).status).toBe(500);
    expect(state.voucherUsed).toBe(false);
    expect(state.discounts).toEqual([]);
    state.gate = real;
    expect((await voucher(c, 'FIRSTRELIC')).text).toContain('Voucher FIRSTRELIC applied.');
    expect(state.voucherUsed).toBe(true);
    state.voucherUsed = false; // forced: even then the cart refuses a second FIRSTRELIC discount
    expect((await voucher(c, 'FIRSTRELIC')).text).toContain('This voucher has already been used.');
    expect(discountsOf((await home(c)).text)).toHaveLength(1);
    expect(state.voucherUsed).toBe(false);
  });

  it('divine: the voucher is reserved in the check\'s own synchronous step, before the validation pause', async () => {
    const c = await ctx('divine');
    await add(c, 'LANTERN', '1');
    const state = labState(c.sid, 'divine');
    let usedDuringPause: boolean | undefined;
    state.gate = { arrive: () => {}, pass: async () => { usedDuringPause = state.voucherUsed; } };
    await voucher(c, 'FIRSTRELIC');
    expect(usedDuringPause).toBe(true);
  });

  it('every level: the validation pause is VALIDATION_MS = 1000 ms on the shop gate, and the production gate waits on the clock', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      await add(c, 'LANTERN', '1');
      const seen: number[] = [];
      labState(c.sid, level).gate = { arrive: () => {}, pass: async (ms) => { seen.push(ms); } };
      await voucher(c, 'FIRSTRELIC');
      expect(seen, level).toEqual([1000]);
    }
  });

  it('every level: a refused request never reaches the pause, but the route still counts it as an arrival', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      const seen: string[] = [];
      labState(c.sid, level).gate = { arrive: () => { seen.push('arrive'); }, pass: async () => { seen.push('pass'); } };
      await voucher(c, 'NOPE');
      expect(seen, level).toEqual(['arrive']);
    }
  });

  it('every level: checkout needs the wallet to cover what the voucher leaves, and an empty cart is no order', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      expect((await checkout(c)).text, level).toContain('Your cart is empty.');
      await add(c, 'CANDLE', '10'); // exactly the wallet
      const res = await checkout(c);
      expect(res.text, level).toContain('Order #1 placed');
      expect(walletOf(res.text), level).toBe(0);
    }
  });

  it('a paid order spends the voucher for good (single use per account): the next order cannot use it', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      await add(c, 'CANDLE', '9');
      await voucher(c, 'FIRSTRELIC');
      await checkout(c);
      await add(c, 'CANDLE', '9');
      expect((await voucher(c, 'FIRSTRELIC')).text, level).toContain('This voucher has already been used.');
      expect(cartOf((await home(c)).text), level).toHaveLength(1);
    }
  });

  it('platform safety: quantities are 1 to 99 and only catalog SKUs are added', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      for (const qty of ['0', '-1', '100', '1.5', '', 'x']) expect((await add(c, 'CANDLE', qty)).text, `${level} ${qty}`).toContain('Quantity must be a whole number from 1 to 99.');
      expect((await add(c, 'NOPE', '1')).text, level).toContain('Unknown product.');
    }
  });

  it('Restart: the wallet, the cart, the discounts, the voucher and the orders start over, and the race can be run again', async () => {
    const c = await ctx('acolyte');
    await add(c, 'LANTERN', '1');
    await race(c, ['FIRSTRELIC', 'FIRSTRELIC']);
    await add(c, 'CANDLE', '1');
    expect(walletOf((await home(c)).text)).toBe(500);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(2500);
    expect(ordersOf(fresh)).toEqual([]);
    expect(cartOf(fresh)).toEqual([]);
    expect(discountsOf(fresh)).toEqual([]);
    expect(labState(c.sid, 'acolyte').voucherUsed).toBe(false);
    // Restart built a fresh state with the real gate again: install the barrier again, right before the race.
    await add(c, 'LANTERN', '1');
    const flag = ordersOf((await race(c, ['FIRSTRELIC', 'FIRSTRELIC'])).checkout.text)[0].flag;
    expect(flag).toMatch(FLAG_RE);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-07', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('the voucher is the lab\'s constant: FIRSTRELIC, $15.00 off, minimum $20.00', () => {
    expect(VOUCHER).toEqual({ code: 'FIRSTRELIC', amount: 1500, min: 2000 });
  });
});

describe('RM-07 production window', () => {
  const clock = useFakeClock();

  it('every level: with the shop\'s own gate the validation really waits 1000 ms on the clock', async () => {
    for (const level of RM07.levels) {
      const c = await ctx(level);
      await add(c, 'LANTERN', '1');
      const t0 = clock.now();
      await voucher(c, 'FIRSTRELIC');
      expect(clock.now() - t0, level).toBe(1000);
      const t1 = clock.now();
      await voucher(c, 'NOPE'); // refused before the pause: no wait
      expect(clock.now() - t1, level).toBe(0);
    }
  });
});
