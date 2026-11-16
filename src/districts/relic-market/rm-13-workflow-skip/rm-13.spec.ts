// src/districts/relic-market/rm-13-workflow-skip/rm-13.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { bare, describeExploitMatrix, describeLabView, FLAG_RE, freshSession, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import {
  cartOf, describeShopBasics, ordersOf, productForm, shopClient, walletOf, type ShopCtx,
} from '../_shared/shop-lab.testkit.js';
import { RM13 } from './challenge.js'; // registers RM-13 before createApp() inside freshSession
import { START_WALLET, labState, pspKey, signNotify } from './model.js';
import * as divine from './levels/divine.js';

const LAB = '/d/relic-market/workflow-skip';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { ctx, home, form, post, add } = shop;
const url = (level: Level, sub: string) => `${LAB}${sub}?level=${level}`;
const confirmUrl = (level: Level) => url(level, '/checkout/confirm');

/** The checkout panels of a page, newest first: the id and the state the page shows. */
const panelsOf = (html: string) => [...html.matchAll(/data-checkout="([0-9a-f]{8})" data-state="([a-z]+)"/g)].map(([, id, state]) => ({ id, state }));
const idOf = (res: { text: string }): string => {
  const first = panelsOf(res.text)[0];
  if (first === undefined) throw new Error('the page shows no checkout');
  return first.id;
};
/** Fill the cart with one product and start a checkout from it; the new checkout's id. */
async function start(c: Ctx, sku = 'RELIQUARY'): Promise<string> {
  await add(c, sku, '1');
  return idOf(await post(c, '/checkout/start'));
}
const shipping = (c: Ctx, id: string, address = '1 Lantern Lane, Bandung') => post(c, '/checkout/shipping', { checkout: id, address });
/** Pay, and follow the lab-local 303 to the return page the way a browser does. */
async function pay(c: Ctx, id: string): Promise<request.Response> {
  const res = await post(c, '/checkout/pay', { checkout: id });
  return res.status === 303 ? c.agent.get(res.headers.location) : res;
}
const confirm = (c: Ctx, id: string) => post(c, '/checkout/confirm', { checkout: id });
/** A candle through all four steps, the way a customer does it. */
async function fullFlow(c: Ctx, sku = 'CANDLE'): Promise<request.Response> {
  const id = await start(c, sku);
  await shipping(c, id);
  await pay(c, id);
  return confirm(c, id);
}

// Acolyte: confirm checks nothing.
const acolyteExploit: Script = async (c) => confirm(c, await start(c));
// Templar: confirm trusts a client-held cookie that says the payment step happened. The cookie is named after the level
// the exploit is SENT TO, so a Divine that read its own cookie would be caught.
const templarExploit: Script = async (c) => {
  const id = await start(c);
  if (c.app === undefined) throw new Error('the matrix hands over the app');
  return bare(c.app, c.sid, `relic_step_${c.level}=paid`).post(confirmUrl(c.level)).type('form').send({ checkout: id });
};
// Inquisitor: the return URL is trusted: the browser says the payment succeeded.
const inquisitorExploit: Script = async (c) => {
  const id = await start(c);
  await c.agent.get(url(c.level, `/checkout/return`) + `&checkout=${id}&status=success`);
  return confirm(c, id);
};

describeExploitMatrix<Script>({
  challenge: RM13,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Payment required.',
  resistedStatus: 402,
  legit: [{ name: 'a candle through start, shipping, pay and confirm', input: async (c) => fullFlow(c), expect: 'confirmed for shipping' }],
  malformed: [],
  privileged: null,
});

describeShopBasics({
  challenge: RM13, path: LAB, labState, hasRestart: true,
  purchase: async (agent: Agent, level: Level) => {
    const c: Ctx = { agent, level, sid: '' };
    return fullFlow(c);
  },
});

describeLabView({
  challenge: RM13,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'qty',
  extra: { intent: 'add', sku: 'CANDLE' },
  oddBodies: [
    { intent: 'add', sku: 'CANDLE', qty: { a: 1 } }, { intent: 'shipping', checkout: ['x'], address: { a: 1 } },
    { intent: 'pay', checkout: {} }, { intent: 'confirm' }, { intent: ['start'] }, { intent: 'start', sku: [1] }, [],
  ],
  ok: async (agent, level, sid) => add({ agent, level, sid }, 'CANDLE', '1'),
  bad: async (agent, level, sid) => add({ agent, level, sid }, 'GRAIL', '1'),
});

describeCurlExample({ challenge: RM13, path: LAB, curl: () => ({ path: '/checkout/confirm', form: ['checkout=<checkout id>'] }) });

const appOf = (c: Ctx) => {
  if (c.app === undefined) throw new Error('the context has no app');
  return c.app;
};
const stateOf = (c: Ctx, id: string) => labState(c.sid, c.level).checkouts.find((x) => x.id === id);

describe('RM-13 the shop and the flow', () => {
  it('a $5.00 wallet, a $200.00 Reliquary and a $2.50 candle; the checkout starts from the cart, the cart form posts intent start', async () => {
    const c = await ctx('acolyte');
    const html = (await home(c)).text;
    expect(walletOf(html)).toBe(START_WALLET);
    expect(START_WALLET).toBe(500);
    expect(productForm(html, 'RELIQUARY')).toMatchObject({ sku: 'RELIQUARY' });
    expect(html).toContain('$200.00');
    await add(c, 'CANDLE', '2');
    const withCart = (await home(c)).text;
    expect(withCart).toMatch(/<form method="post">\s*<input type="hidden" name="intent" value="start">/);
    expect(withCart).not.toContain('value="checkout"');
  });

  it('start needs a cart; it moves the cart into a checkout of 8 hex characters (created), and the cart is empty', async () => {
    const c = await ctx('acolyte');
    expect((await post(c, '/checkout/start')).text).toContain('Your cart is empty.');
    const id = await start(c, 'RELIQUARY');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const html = (await home(c)).text;
    expect(cartOf(html)).toEqual([]);
    expect(panelsOf(html)).toEqual([{ id, state: 'created' }]);
    expect(stateOf(c, id)).toMatchObject({ state: 'created', total: 20000, paid: 0, address: '' });
  });

  it('shipping needs an address (kept clipped to 100 characters, escaped on the page) and moves created to shipping', async () => {
    const c = await ctx('acolyte');
    const id = await start(c, 'CANDLE');
    expect((await shipping(c, id, '')).text).toContain('Enter a shipping address.');
    const res = await shipping(c, id, `<b>${'x'.repeat(200)}`);
    expect(panelsOf(res.text)).toEqual([{ id, state: 'shipping' }]);
    expect(stateOf(c, id)?.address).toHaveLength(100);
    expect(res.text).toContain('&lt;b&gt;xxx');
    expect(res.text).not.toContain('<b>xxx');
  });

  it('an unknown, odd or foreign checkout id is a refusal on the page (200), never a 500', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      await start(c, 'CANDLE');
      for (const id of ['', 'nope', 'constructor', '__proto__', 'x'.repeat(3000), '0000000g']) {
        for (const sub of ['/checkout/shipping', '/checkout/pay', '/checkout/confirm']) {
          const res = await post(c, sub, { checkout: id, address: 'a' });
          expect(res.status, `${level} ${sub}`).toBe(200);
          expect(res.text, level).toContain('Unknown checkout.');
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
      const ret = await c.agent.get(url(level, '/checkout/return') + '&checkout=nope&status=success');
      expect(ret.status, level).toBe(404);
    }
  });

  it('only the newest 10 checkouts are kept; an evicted one cannot be confirmed', async () => {
    const c = await ctx('acolyte');
    const first = await start(c, 'CANDLE');
    for (let i = 0; i < 10; i++) await start(c, 'CANDLE');
    expect(labState(c.sid, 'acolyte').checkouts).toHaveLength(10);
    expect(panelsOf((await home(c)).text)).toHaveLength(10);
    expect((await confirm(c, first)).text).toContain('Unknown checkout.');
  });

  it('a candle through all four steps charges the wallet once and places one confirmed order, with no flag, at every level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const res = await fullFlow(c);
      expect(res.status, level).toBe(200);
      expect(res.text, level).toMatch(/Order #1 confirmed for shipping\./);
      expect(res.text, level).not.toMatch(FLAG_RE);
      expect(walletOf(res.text), level).toBe(START_WALLET - 250);
      expect(ordersOf(res.text), level).toEqual([{ no: 1, total: 250, charged: 250, status: 'confirmed' }]);
    }
  });

  it('pay with too little money is 402 Insufficient funds, charges nothing and moves nothing, at every level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const id = await start(c, 'RELIQUARY');
      await shipping(c, id);
      const res = await post(c, '/checkout/pay', { checkout: id });
      if (res.status === 303) {
        const ret = await c.agent.get(res.headers.location);
        expect(res.headers.location, level).toContain('status=failed');
        expect(ret.text, level).toContain('Payment failed');
      } else {
        expect(res.status, level).toBe(402);
        expect(res.text, level).toContain('Insufficient funds: the total is $200.00 and your wallet holds $5.00.');
      }
      expect(labState(c.sid, level).wallet, level).toBe(START_WALLET);
      expect(stateOf(c, id)?.state, level).toBe('shipping');
      expect((await confirm(c, id)).status, level).toBe(level === 'acolyte' ? 200 : 402);
    }
  });

  it('a checkout cannot be paid twice or confirmed twice: one charge, one order', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      const id = await start(c, 'CANDLE');
      await shipping(c, id);
      await pay(c, id);
      const again = await post(c, '/checkout/pay', { checkout: id });
      expect(again.status, level).toBe(409);
      expect(again.text, level).toContain('already paid');
      expect(labState(c.sid, level).wallet, level).toBe(START_WALLET - 250);
      const first = await confirm(c, id);
      const second = await confirm(c, id);
      expect(first.text, level).toContain('confirmed for shipping');
      expect(second.status, level).toBe(200);
      expect(second.text, level).toContain('already confirmed');
      expect(ordersOf(second.text), level).toHaveLength(1);
    }
  });
});

describe('RM-13 acolyte and templar', () => {
  it('acolyte: confirm right after start earns an order for the Reliquary with charged $0.00, and the flag', async () => {
    const c = await ctx('acolyte');
    const res = await confirm(c, await start(c));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Order #1 confirmed for shipping\. Flag: HVWA\{[0-9a-f]{32}\}/);
    expect(ordersOf(res.text)).toMatchObject([{ no: 1, total: 20000, charged: 0, status: 'confirmed', flag: expect.stringMatching(/^HVWA\{/) }]);
    expect(walletOf(res.text)).toBe(START_WALLET);
  });

  it('templar: paying sets relic_step_templar=paid (readable, canonical path); confirm trusts only that cookie', async () => {
    const c = await ctx('templar');
    const id = await start(c, 'CANDLE');
    await shipping(c, id);
    const paid = await post(c, '/checkout/pay', { checkout: id });
    const line = [paid.headers['set-cookie'] ?? []].flat().find((l) => l.startsWith('relic_step_templar=')) ?? '';
    expect(line).toContain('relic_step_templar=paid');
    expect(line).toContain(`Path=${LAB}`);
    expect(line).not.toMatch(/HttpOnly/i);
    // Paid on the server, but a request without the cookie is refused: the server's own state is not what it checks.
    expect(stateOf(c, id)?.state).toBe('paid');
    const noCookie = await bare(appOf(c), c.sid).post(confirmUrl('templar')).type('form').send({ checkout: id });
    expect(noCookie.status).toBe(402);
    expect(noCookie.text).toContain('Payment required.');
    expect((await confirm(c, id)).status).toBe(200); // the agent keeps the cookie
  });

  it('templar: only the exact value counts, and a failed payment sets no cookie', async () => {
    const c = await ctx('templar');
    const id = await start(c, 'RELIQUARY');
    await shipping(c, id);
    const failed = await post(c, '/checkout/pay', { checkout: id });
    expect(failed.status).toBe(402);
    expect([failed.headers['set-cookie'] ?? []].flat().some((l) => l.startsWith('relic_step_'))).toBe(false);
    for (const value of ['', 'x', 'Paid', 'paid ', 'true', '1']) {
      const res = await bare(appOf(c), c.sid, `relic_step_templar=${encodeURIComponent(value)}`).post(confirmUrl('templar')).type('form').send({ checkout: id });
      expect(res.status, value).toBe(402);
      expect(res.text, value).not.toMatch(FLAG_RE);
    }
    const forged = await bare(appOf(c), c.sid, 'relic_step_templar=paid').post(confirmUrl('templar')).type('form').send({ checkout: id });
    expect(forged.status).toBe(200);
    expect(forged.text).toMatch(FLAG_RE);
  });

  it('the cookie is per level: another level\'s cookie opens nothing', async () => {
    for (const level of ['inquisitor', 'divine'] as const) {
      const c = await ctx(level);
      const id = await start(c);
      const res = await bare(appOf(c), c.sid, 'relic_step_templar=paid; relic_step_acolyte=paid').post(confirmUrl(level)).type('form').send({ checkout: id });
      expect(res.status, level).toBe(402);
    }
  });
});

describe('RM-13 inquisitor', () => {
  it('paying answers 303 to the lab-local return page with the level, and the return page marks it paid', async () => {
    const c = await ctx('inquisitor');
    const id = await start(c, 'CANDLE');
    const res = await post(c, '/checkout/pay', { checkout: id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${LAB}/checkout/return?checkout=${id}&status=success&level=inquisitor`);
    const ret = await c.agent.get(res.headers.location);
    expect(ret.status).toBe(200);
    expect(stateOf(c, id)).toMatchObject({ state: 'paid', paid: 250 });
    expect(labState(c.sid, 'inquisitor').wallet).toBe(START_WALLET - 250);
  });

  it('the return URL is trusted: status=success marks the checkout paid without any charge; anything else does not', async () => {
    const c = await ctx('inquisitor');
    const id = await start(c, 'RELIQUARY');
    for (const status of ['failed', 'SUCCESS', 'success ', '', 'pending', 'true']) {
      await c.agent.get(url('inquisitor', '/checkout/return') + `&checkout=${id}&status=${encodeURIComponent(status)}`);
      expect(stateOf(c, id)?.state, status).toBe('created');
    }
    const res = await c.agent.get(url('inquisitor', '/checkout/return') + `&checkout=${id}&status=success`);
    expect(res.status).toBe(200);
    expect(stateOf(c, id)).toMatchObject({ state: 'paid', paid: 20000 });
    expect(labState(c.sid, 'inquisitor').wallet).toBe(START_WALLET); // nothing was charged
    const done = await confirm(c, id);
    expect(done.text).toMatch(/confirmed for shipping\. Flag: HVWA\{/);
    expect(ordersOf(done.text)).toMatchObject([{ total: 20000, charged: 0, status: 'confirmed' }]);
  });

  it('confirm needs the server state paid: created or shipping is 402; the templar cookie is no use', async () => {
    const c = await ctx('inquisitor');
    const id = await start(c);
    expect((await confirm(c, id)).status).toBe(402);
    await shipping(c, id);
    expect((await confirm(c, id)).status).toBe(402);
    const res = await bare(appOf(c), c.sid, 'relic_step_inquisitor=paid').post(confirmUrl('inquisitor')).type('form').send({ checkout: id });
    expect(res.status).toBe(402);
  });
});

describe('RM-13 divine', () => {
  const notifyOf = (c: Ctx, id: string, over: Partial<{ amount: number; status: 'success' | 'failed'; checkout: string }> = {}, key = pspKey(c.sid, c.level)) => {
    const m = { checkout: id, amount: 250, status: 'success' as const, ...over };
    return { ...m, signature: signNotify(key, m) };
  };

  it('the return URL only displays the server state: status=success marks nothing paid, and confirm is 402', async () => {
    const c = await ctx('divine');
    const id = await start(c);
    await shipping(c, id);
    const res = await c.agent.get(url('divine', '/checkout/return') + `&checkout=${id}&status=success`);
    expect(res.status).toBe(200);
    expect(stateOf(c, id)).toMatchObject({ state: 'shipping', paid: 0 });
    const done = await confirm(c, id);
    expect(done.status).toBe(402);
    expect(done.text).toContain('Payment required.');
  });

  it('a notify signed with the PSP key for the right amount marks the checkout paid, and confirm then succeeds with no flag', async () => {
    const c = await ctx('divine');
    const id = await start(c, 'CANDLE');
    await shipping(c, id);
    const state = labState(c.sid, 'divine');
    expect(divine.notify(state, notifyOf(c, id))).toBe(true);
    expect(stateOf(c, id)).toMatchObject({ state: 'paid', paid: 250 });
    const done = await confirm(c, id);
    expect(done.status).toBe(200);
    expect(done.text).toContain('confirmed for shipping');
    expect(done.text).not.toMatch(FLAG_RE);
    expect(divine.notify(state, notifyOf(c, id))).toBe(false); // each transition happens once
  });

  it('a wrong amount, a wrong or missing signature, a failed status, another key or another checkout leave it unpaid', async () => {
    const c = await ctx('divine');
    const id = await start(c, 'CANDLE');
    const other = await start(c, 'RELIQUARY');
    await shipping(c, id);
    await shipping(c, other);
    const state = labState(c.sid, 'divine');
    const good = notifyOf(c, id);
    const bad = [
      notifyOf(c, id, { amount: 1 }), notifyOf(c, id, { amount: 20000 }),
      { ...good, signature: '' }, { ...good, signature: 'zz' }, { ...good, signature: 'a'.repeat(64) },
      { ...good, signature: good.signature.slice(0, -2) }, { ...good, amount: 20000 }, { ...good, status: 'failed' as const },
      notifyOf(c, id, { status: 'failed' }), notifyOf(c, id, {}, Buffer.alloc(32, 7)), notifyOf(c, id, { checkout: 'deadbeef' }),
      { ...good, checkout: other },
    ];
    for (const m of bad) expect(divine.notify(state, m), JSON.stringify(m).slice(0, 80)).toBe(false);
    expect(stateOf(c, id)?.state).toBe('shipping');
    expect(stateOf(c, other)?.state).toBe('shipping');
    expect(divine.notify(state, good)).toBe(true);
  });

  it('the full flow: shipping first, then pay (303 to the return page), then confirm; paying before shipping is refused', async () => {
    const c = await ctx('divine');
    const id = await start(c, 'CANDLE');
    const early = await post(c, '/checkout/pay', { checkout: id });
    expect(early.status).toBe(409);
    expect(early.text).toContain('shipping address');
    expect(labState(c.sid, 'divine').wallet).toBe(START_WALLET);
    await shipping(c, id);
    const res = await post(c, '/checkout/pay', { checkout: id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${LAB}/checkout/return?checkout=${id}&status=success&level=divine`);
    const ret = await c.agent.get(res.headers.location);
    expect(ret.text).toContain('Payment received');
    expect(stateOf(c, id)).toMatchObject({ state: 'paid', paid: 250 });
    expect((await confirm(c, id)).text).toContain('confirmed for shipping');
  });

  it('the notify is an internal call: there is no public route for it at any level', async () => {
    for (const level of LEVELS) {
      const c = await ctx(level);
      for (const path of ['/psp/notify', '/checkout/notify', '/notify', '/psp']) {
        for (const send of [c.agent.post(url(level, path)).type('form').send({ checkout: 'x' }), c.agent.get(url(level, path))]) {
          expect((await send).status, `${level} ${path}`).toBe(404);
        }
      }
    }
  });

  it('confirm needs paid AND paid equal to the total (a half-paid state is 402)', async () => {
    const c = await ctx('divine');
    const id = await start(c, 'CANDLE');
    await shipping(c, id);
    const co = stateOf(c, id);
    if (co === undefined) throw new Error('no checkout');
    co.state = 'paid';
    co.paid = 100;
    expect((await confirm(c, id)).status).toBe(402);
  });
});

describe('RM-13 Restart', () => {
  it('Restart drops the checkouts too, and the flag can still be earned afterwards', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const c = await ctx(level);
      const id = await start(c, 'CANDLE');
      expect((await shop.restart(c)).status, level).toBe(303);
      const html = (await home(c)).text;
      expect(panelsOf(html), level).toEqual([]);
      expect(walletOf(html), level).toBe(START_WALLET);
      expect((await confirm(c, id)).text, level).toContain('Unknown checkout.');
      const script = level === 'acolyte' ? acolyteExploit : level === 'templar' ? templarExploit : inquisitorExploit;
      expect((await script(c)).text, level).toMatch(FLAG_RE);
    }
  });
});

describe('RM-13 odds and ends', () => {
  it('Restart is per level and the psp key is per instance (a new shop has a new key)', async () => {
    const a = await ctx('divine');
    await home(a);
    const key = pspKey(a.sid, 'divine');
    expect(key).toHaveLength(32);
    await shop.restart(a);
    await home(a);
    expect(pspKey(a.sid, 'divine').equals(key)).toBe(false);
    const b = await freshSession();
    expect(pspKey(b.sid, 'divine').equals(key)).toBe(false);
  });

  it('a checkout panel shows its four steps and the proof order row carries the flag line only below divine', async () => {
    const c = await ctx('acolyte');
    const id = await start(c);
    const html = (await home(c)).text;
    for (const step of ['Start', 'Shipping', 'Pay', 'Confirm']) expect(html).toContain(step);
    expect(html).toContain(`data-checkout="${id}"`);
    const res = await confirm(c, id);
    expect(panelsOf(res.text)).toEqual([{ id, state: 'confirmed' }]);
    expect(ordersOf(res.text)[0].flag).toMatch(FLAG_RE);
  });
});
