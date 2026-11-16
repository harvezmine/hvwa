// src/districts/relic-market/rm-05-negative-quantity/rm-05.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, freshSession, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { cartOf, describeShopBasics, ordersOf, walletOf } from '../_shared/shop-lab.testkit.js';
import { RM05 } from './challenge.js'; // registers RM-05 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/relic-market/negative-quantity';
interface Ctx { readonly agent: Agent; readonly level: Level; readonly sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

// The named paths (what curl and scripts use) ...
const add = (c: Ctx, sku: string, qty: string) => c.agent.post(`${LAB}/cart?level=${c.level}`).type('form').send({ sku, qty });
const giveBack = (c: Ctx, sku: string, qty: string) => c.agent.post(`${LAB}/cart/return?level=${c.level}`).type('form').send({ sku, qty });
const checkout = (c: Ctx) => c.agent.post(`${LAB}/checkout?level=${c.level}`).type('form').send({});
// ... and the page's own forms (POST / with a hidden intent).
const form = (c: Ctx, body: Record<string, string>) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send(body);
const home = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const ctx = async (level: Level): Promise<Ctx> => { const { agent, sid } = await freshSession(); return { agent, level, sid }; };

// Acolyte: any integer is a quantity, so 25 rosaries at -$40.00 pay for the $1,000.00 reliquary.
const acolyteExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await add(c, 'ROSARY', '-25'); return checkout(c); };
// Templar: the filter looks at the first character; parseInt skips the leading space.
const templarExploit: Script = async (c) => { await add(c, 'RELIQUARY', '1'); await add(c, 'ROSARY', ' -25'); return checkout(c); };
// Inquisitor: buy one rosary, then return it 25 times over against the reliquary (nobody counts how many).
const inquisitorExploit: Script = async (c) => {
  await add(c, 'ROSARY', '1');
  await checkout(c);
  await add(c, 'RELIQUARY', '1');
  await giveBack(c, 'ROSARY', '25');
  return checkout(c);
};

describeExploitMatrix<Script>({
  challenge: RM05,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Insufficient funds: the total is \$1,000\.00 and your wallet holds \$(50|10)\.00\./,
  legit: [{
    name: 'buy 2 votive candles',
    input: async (c) => { await form(c, { intent: 'add', sku: 'CANDLE', qty: '2' }); return form(c, { intent: 'checkout' }); },
    expect: 'Order #1 placed',
  }],
  malformed: [],
  privileged: null,
});

describeShopBasics({ challenge: RM05, path: LAB, labState, hasRestart: true });

describeLabView({
  challenge: RM05,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'qty',
  extra: { intent: 'add', sku: 'CANDLE' },
  oddBodies: [
    { intent: ['add'], sku: { a: 1 } }, { intent: 'add', sku: ['CANDLE'], qty: { a: 1 } },
    { intent: 'return', sku: 'ROSARY', qty: [] }, { intent: 'checkout', extra: { deep: [1] } }, [],
  ],
  ok: (agent, level, sid) => form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: '1' }),
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'add', sku: 'CANDLE', qty: 'many' }),
});

describeCurlExample({ challenge: RM05, path: LAB, curl: () => ({ path: '/cart', form: ['sku=ROSARY', 'qty=1'] }) });

describe('RM-05 negative quantity', () => {
  it('acolyte: the exploit is a paid $0.00 order with the reliquary, and the flag stays on the order row', async () => {
    const c = await ctx('acolyte');
    const res = await acolyteExploit(c);
    expect(res.text).toContain('Order #1 placed');
    const [order] = ordersOf(res.text);
    expect(order).toMatchObject({ no: 1, total: 0, charged: 0, status: 'paid' });
    expect(order.flag).toMatch(FLAG_RE);
    expect(walletOf(res.text)).toBe(5000);
    await form(c, { intent: 'add', sku: 'CANDLE', qty: '2' });
    const later = await form(c, { intent: 'checkout' });
    const orders = ordersOf(later.text);
    expect(orders.map((o) => o.no)).toEqual([2, 1]);
    expect(orders[0].flag).toBeUndefined();
    expect(orders[1].flag).toBe(order.flag);
    expect(ordersOf((await home(c)).text)[1].flag).toBe(order.flag);
  });

  it('acolyte: negative lines are shown honestly, each line and the total in the cart', async () => {
    const c = await ctx('acolyte');
    await add(c, 'RELIQUARY', '1');
    const res = await add(c, 'ROSARY', '-25');
    expect(res.text).toContain("Cart updated: Pilgrim&#39;s Rosary × -25.");
    expect(cartOf(res.text)).toEqual([
      { sku: 'RELIQUARY', qty: 1, line: 100000, kind: '' },
      { sku: 'ROSARY', qty: -25, line: -100000, kind: '' },
    ]);
    expect(res.text).toMatch(/× -25<\/td><td>-\$1,000\.00<\/td>/);
    expect(res.text).toMatch(/data-testid="cart-total" data-cents="0">\$0\.00</);
  });

  it('templar: a leading minus is refused, a leading space is not (parseInt skips it)', async () => {
    const c = await ctx('templar');
    expect((await add(c, 'ROSARY', '-25')).text).toContain('Quantity cannot be negative.');
    expect(cartOf((await home(c)).text)).toEqual([]);
    const res = await add(c, 'ROSARY', ' -25');
    expect(cartOf(res.text)).toEqual([{ sku: 'ROSARY', qty: -25, line: -100000, kind: '' }]);
  });

  it('inquisitor: a quantity is 1 to 99 everywhere, and checkout refuses a negative total', async () => {
    const c = await ctx('inquisitor');
    for (const qty of [' -25', '-1', '0', '100', '1.5', '+1', '1e1', '', ' 1', '01x']) {
      expect((await add(c, 'ROSARY', qty)).text, JSON.stringify(qty)).toContain('Quantity must be a whole number from 1 to 99.');
      expect((await giveBack(c, 'ROSARY', qty)).text, JSON.stringify(qty)).toContain('Quantity must be a whole number from 1 to 99.');
    }
    expect((await giveBack(c, 'ROSARY', '1')).text).toContain('You can only return items you have bought.');
    await add(c, 'ROSARY', '1');
    expect((await checkout(c)).text).toContain('Order #1 placed');
    await giveBack(c, 'ROSARY', '2');
    const res = await checkout(c);
    expect(res.text).toContain('The order total cannot be negative.');
    expect(ordersOf(res.text)).toHaveLength(1);
  });

  it('inquisitor: returning more than you bought works (the flaw), and adds up within the cart', async () => {
    const c = await ctx('inquisitor');
    await add(c, 'ROSARY', '1');
    await checkout(c);
    await giveBack(c, 'ROSARY', '20');
    const res = await giveBack(c, 'ROSARY', '5');
    expect(cartOf(res.text)).toEqual([{ sku: 'ROSARY', qty: -25, line: -100000, kind: 'return' }]);
  });

  it('divine: a return is bounded by what was bought, minus what was returned, minus returns already in the cart', async () => {
    const c = await ctx('divine');
    expect((await giveBack(c, 'ROSARY', '1')).text).toContain('You can return at most 0 Pilgrim&#39;s Rosary.');
    await add(c, 'ROSARY', '1');
    await checkout(c); // owned 1, wallet $10.00
    expect((await giveBack(c, 'ROSARY', '2')).text).toContain('You can return at most 1 Pilgrim&#39;s Rosary.');
    expect(cartOf((await giveBack(c, 'ROSARY', '1')).text)).toEqual([{ sku: 'ROSARY', qty: -1, line: -4000, kind: 'return' }]);
    expect((await giveBack(c, 'ROSARY', '1')).text).toContain('You can return at most 0 Pilgrim&#39;s Rosary.'); // one is pending
    expect((await checkout(c)).text).toContain('The order total cannot be negative.');
    await add(c, 'ROSARY', '1'); // exchange: buy one, return one, $0.00
    expect((await checkout(c)).text).toContain('Order #2 placed');
    const state = labState(c.sid, 'divine');
    expect([...state.owned]).toEqual([['ROSARY', 2]]);
    expect([...state.returned]).toEqual([['ROSARY', 1]]);
    expect((await giveBack(c, 'ROSARY', '2')).text).toContain('You can return at most 1 Pilgrim&#39;s Rosary.');
    expect((await giveBack(c, 'ROSARY', '1')).text).toContain('Cart updated');
  });

  it('divine: checkout needs 0 <= total <= wallet; prices are the server catalog\'s', async () => {
    const c = await ctx('divine');
    await add(c, 'RELIQUARY', '1');
    expect((await checkout(c)).text).toContain('Insufficient funds: the total is $1,000.00 and your wallet holds $50.00.');
    await add(c, 'RELIQUARY', '0'); // 0 is no quantity at Divine: the line stays
    const res = await c.agent.post(`${LAB}/cart?level=divine`).type('form').send({ sku: 'CANDLE', qty: '2', price: '1', unitPrice: '1' });
    expect(cartOf(res.text)).toEqual([{ sku: 'RELIQUARY', qty: 1, line: 100000, kind: '' }, { sku: 'CANDLE', qty: 2, line: 500, kind: '' }]);
  });

  it('every level: an empty cart is no order, and only catalog SKUs reach the cart and the returns', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      expect((await checkout(c)).text, level).toContain('Your cart is empty.');
      for (const sku of ['NOPE', 'constructor', '__proto__', 'rosary', '']) {
        expect((await add(c, sku, '1')).text, `${level} ${sku}`).toContain('Unknown product.');
        expect((await giveBack(c, sku, '1')).text, `${level} ${sku}`).toContain('Unknown product.');
      }
      await add(c, 'CANDLE', '1');
      await checkout(c);
      const state = labState(c.sid, level);
      expect([...state.owned.keys()], level).toEqual(['CANDLE']);
      expect([...state.returned.keys()], level).toEqual([]);
    }
  });

  it('the return form lists only what you own; the page forms post back with an intent', async () => {
    const c = await ctx('acolyte');
    const first = (await home(c)).text;
    expect(first).not.toContain('value="return"');
    expect(first).toContain('Items you buy can be returned here for store credit.');
    await form(c, { intent: 'add', sku: 'ROSARY', qty: '1' });
    const after = (await form(c, { intent: 'checkout' })).text;
    const returns = /<form method="post">\s*<input type="hidden" name="intent" value="return">[\s\S]*?<\/form>/.exec(after)?.[0] ?? '';
    expect([...returns.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(['ROSARY']);
    expect(returns).toContain('name="qty" type="text"');
    const back = await form(c, { intent: 'return', sku: 'ROSARY', qty: '1' });
    expect(cartOf(back.text)).toEqual([{ sku: 'ROSARY', qty: -1, line: -4000, kind: 'return' }]);
    expect(back.text).toContain('(return for store credit)');
    expect((await form(c, { intent: 'bogus' })).text).toMatch(/class="lab-message lab-error"[^>]*>Unknown action\./);
  });

  it('acolyte: the shell bound still applies to what the level accepts', async () => {
    const c = await ctx('acolyte');
    expect((await add(c, 'ROSARY', '-10000000000')).text).toContain('Quantity too large for this shop.');
    expect((await add(c, 'ROSARY', '9'.repeat(400))).text).toContain('Quantity too large for this shop.');
    expect((await add(c, 'ROSARY', 'many')).text).toContain('Quantity must be a number.');
  });

  it('Restart: a spent wallet starts over, and the flag can still be earned afterwards', async () => {
    const c = await ctx('acolyte');
    await inquisitorExploit(c); // works at acolyte too: wallet $10.00, two orders
    expect(walletOf((await home(c)).text)).toBe(1000);
    expect((await c.agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(5000);
    expect(ordersOf(fresh)).toEqual([]);
    expect(cartOf(fresh)).toEqual([]);
    expect([...labState(c.sid, 'acolyte').owned]).toEqual([]);
    const res = await acolyteExploit(c);
    const flag = ordersOf(res.text)[0].flag;
    expect(flag).toMatch(FLAG_RE);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-05', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });
});
