// src/districts/relic-market/_shared/shop-lab.spec.ts — the Relic Market shell's Express side: intent dispatch, the
// flag lines, the staff-code check, the shared view data and the partials (with the test kit's page readers).
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response } from 'express';
import { renderFile } from 'ejs';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { FLAG_RE } from '../../../../tests/helpers.js';
import { flagFor } from '../../../core/mount.js';
import type { Level } from '../../../core/levels.js';
import { catalogOf, exactTotals, newShop, pinOrder, placeOrder, orderLines, setLine, type Order, type ShopState } from './shop.js';
import {
  baseView, cartView, catalogView, endpointsOf, flagLine, mountIntents, ordersView, refusal, success, removeLineIntent, shopView, welcome,
  type Intent, type Outcome,
} from './shop-lab.js';
import * as sharedIntents from '../../_shared/intents.js';
import { redeemCode } from './staff-code.js';
import { cartOf, orderIdsOf, ordersOf, productForm, walletOf } from './shop-lab.testkit.js';

const C = { id: 'RX-01', levels: ['acolyte', 'templar', 'divine'] as const satisfies readonly Level[] };
const at = (level: Level) => ({ sessionId: 'sid-shell', level });

describe('the intent routing, re-exported from districts/_shared/intents.ts (Q15)', () => {
  it('relic-market/_shared/shop-lab.js still exports the very same functions', () => {
    expect([mountIntents, endpointsOf, refusal, success]).toEqual([sharedIntents.mountIntents, sharedIntents.endpointsOf, sharedIntents.refusal, sharedIntents.success]);
    expect(mountIntents).toBe(sharedIntents.mountIntents);
    expect(refusal).toBe(sharedIntents.refusal);
  });
});

describe('flag lines', () => {
  it('flagLine: the flag below Divine, nothing at Divine', () => {
    expect(flagLine(at('acolyte'), C)).toBe(`Flag: ${flagFor(at('acolyte'), C)}`);
    expect(flagLine(at('templar'), C)).toMatch(FLAG_RE);
    expect(flagLine(at('divine'), C)).toBe('');
  });

  it('welcome: the admin gets the flag below Divine, a customer never', () => {
    const admin = { username: 'relic_admin', role: 'admin' };
    expect(welcome(at('acolyte'), C, admin)).toEqual({ ok: true, text: `Welcome, relic_admin (role: admin). Flag: ${flagFor(at('acolyte'), C)}` });
    expect(welcome(at('divine'), C, admin)).toEqual({ ok: true, text: 'Welcome, relic_admin (role: admin).' });
    expect(welcome(at('acolyte'), C, { username: 'pilgrim', role: 'customer' })).toEqual({ ok: true, text: 'Welcome, pilgrim (role: customer).' });
  });

  it('redeemCode: the exact code earns the flag below Divine; anything else, of any length, is invalid', () => {
    const secret = 'a1b2c3d4';
    expect(redeemCode(at('acolyte'), C, secret, secret, 'staff code')).toEqual({ ok: true, text: `Staff code accepted. Flag: ${flagFor(at('acolyte'), C)}` });
    expect(redeemCode(at('divine'), C, secret, secret, 'staff code')).toEqual({ ok: true, text: 'Staff code accepted.' });
    expect(redeemCode(at('templar'), C, 'abc123', 'abc123', 'vault PIN').text).toMatch(/^Vault PIN accepted\. Flag: HVWA\{/);
    for (const input of ['', 'a1b2c3d', 'a1b2c3d4 ', 'A1B2C3D4', 'a1b2c3d5', 'x'.repeat(1000)]) {
      expect(redeemCode(at('acolyte'), C, secret, input, 'staff code'), input).toEqual({ ok: false, text: 'Invalid staff code.' });
    }
  });
});

// --- shopView and the partials --------------------------------------------------------------------------------------

const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary <of> "Saints"', price: 100000, blurb: 'A relic & more.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Wax.' },
]);
const LAB = '/d/relic-market/shell-fixture';
const views = (name: string) => fileURLToPath(new URL(`./views/${name}.ejs`, import.meta.url));
const proves = (o: Order) => o.lines.some((l) => l.sku === 'RELIQUARY');

/** A shop with one proving order (#1, a reliquary), one plain order (#2) and two cart lines (one a return). */
function fixtureShop(): ShopState {
  const s = newShop({ catalog: CATALOG, wallet: 5000 });
  setLine(s, { sku: 'RELIQUARY', qty: 1, unitPrice: 100000 });
  placeOrder(s, { lines: orderLines(s), subtotal: 0, total: 0, charged: 0 });
  setLine(s, { sku: 'CANDLE', qty: 2, unitPrice: 250 });
  placeOrder(s, { lines: orderLines(s), subtotal: 500, total: 500, charged: 500 });
  setLine(s, { sku: 'CANDLE', qty: 3, unitPrice: 250 });
  setLine(s, { sku: 'RELIQUARY', qty: -25, unitPrice: 100000, kind: 'return' });
  s.wallet = -1050;
  return s;
}

/** shopView's data as JSON, from a real request at `level` (shopView reads the lab path, the level and the body). */
async function viewData(level: Level, body: object = {}): Promise<Record<string, unknown>> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.level = level; req.sessionId = 'sid-shell'; res.locals.labPath = LAB; next(); });
  app.post('/', (req, res) => {
    const state = fixtureShop();
    res.json(shopView(req, res, state, {
      challenge: C, result: { ok: true, text: 'Hello <b>' }, totals: exactTotals(state), proves,
      curl: { path: '/cart', form: { sku: 'CANDLE', qty: '1' } },
      fields: (p) => ({ price: String(p.price) }),
      api: [{ path: '/api/price-lists', description: 'every price list' }],
      extra: { note: 'x' },
    }));
  });
  return (await request(app).post('/').set('Host', '127.0.0.1:3000').type('form').send(body)).body as Record<string, unknown>;
}

const opts = { async: false } as const;
async function renderAll(data: Record<string, unknown>): Promise<string> {
  const parts = ['shop-header', 'message', 'catalog', 'cart', 'orders', 'api'];
  const html = await Promise.all(parts.map((p) => renderFile(views(p), { ...data, heading: 'Relic Market' }, opts)));
  return html.join('\n');
}

describe('shopView', () => {
  it('builds the shared view data: base, served level, customer, wallet, catalog, cart, orders, curl and api', async () => {
    const d = await viewData('acolyte');
    expect(d).toMatchObject({
      base: LAB, served: 'acolyte', customer: { username: 'pilgrim', id: 'C-1042' },
      wallet: { cents: -1050, text: '-$10.50' }, result: { ok: true, text: 'Hello <b>' }, note: 'x',
      api: [{ method: 'GET', path: '/api/price-lists', href: `${LAB}/api/price-lists?level=acolyte`, description: 'every price list' }],
    });
    expect(d.catalog).toEqual([
      { sku: 'RELIQUARY', name: 'Reliquary <of> "Saints"', blurb: 'A relic & more.', price: { cents: 100000, text: '$1,000.00' }, fields: [['price', '100000']], qty: '1' },
      { sku: 'CANDLE', name: 'Votive Candle', blurb: 'Wax.', price: { cents: 250, text: '$2.50' }, fields: [['price', '250']], qty: '1' },
    ]);
    expect(d.cart).toEqual({
      rows: [
        { sku: 'CANDLE', name: 'Votive Candle', qty: 3, kind: '', unit: { cents: 250, text: '$2.50' }, line: { cents: 750, text: '$7.50' }, note: '' },
        { sku: 'RELIQUARY', name: 'Reliquary <of> "Saints"', qty: -25, kind: 'return', unit: { cents: 100000, text: '$1,000.00' }, line: { cents: -2500000, text: '-$25,000.00' }, note: '' },
      ],
      total: { cents: -2499250, text: '-$24,992.50' }, note: '', removable: false, checkoutIntent: 'checkout',
    });
    expect(d.curl).toMatchObject({ url: `http://127.0.0.1:3000${LAB}/cart?level=acolyte`, form: ['sku=CANDLE', 'qty=1'] });
  });

  it('lists orders newest first, each proving order with its flag line below Divine', async () => {
    const d = await viewData('templar');
    const orders = d.orders as { no: number; flag: string; total: { text: string }; lines: { name: string }[] }[];
    expect(orders.map((o) => o.no)).toEqual([2, 1]);
    expect(orders[0].flag).toBe('');
    expect(orders[1].flag).toBe(flagLine(at('templar'), C));
    expect(orders[1].lines[0].name).toBe('Reliquary <of> "Saints"');
    const divine = (await viewData('divine')).orders as { flag: string }[];
    expect(divine.map((o) => o.flag)).toEqual(['', '']);
  });

  it('keeps what the player typed into a product form after a POST (that product\'s field only)', async () => {
    const d = await viewData('acolyte', { intent: 'add', sku: 'CANDLE', qty: '"><x' });
    expect((d.catalog as { qty: string }[]).map((p) => p.qty)).toEqual(['1', '"><x']);
    expect(d.kept).toEqual({ intent: 'add', sku: 'CANDLE', qty: '"><x' });
  });

  it('a line or total the lab could not price is shown as its note, not as money', async () => {
    const app = express();
    app.use((req, res, next) => { req.level = 'acolyte'; req.sessionId = 's'; res.locals.labPath = LAB; next(); });
    app.get('/', (req, res) => {
      const s = newShop({ catalog: CATALOG, wallet: 0 });
      setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: 250 });
      res.json(shopView(req, res, s, {
        challenge: C, result: null, proves, curl: { path: '/cart' },
        totals: { lines: [{ line: s.cart[0], total: 'Line total too large.' }], total: 'out of range' },
      }));
    });
    const d = (await request(app).get('/')).body as { cart: unknown };
    expect(d.cart).toEqual({
      rows: [{ sku: 'CANDLE', name: 'Votive Candle', qty: 1, kind: '', unit: { cents: 250, text: '$2.50' }, line: null, note: 'Line total too large.' }],
      total: null, note: 'out of range', removable: false, checkoutIntent: 'checkout',
    });
  });
});

/** What `build` makes of a real request at `level` (the view builders read the lab path, the level and the body). */
async function built(level: Level, body: object, build: (req: Request, res: Response) => unknown): Promise<Record<string, unknown>> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.level = level; req.sessionId = 'sid-shell'; res.locals.labPath = LAB; next(); });
  app.post('/', (req, res) => { res.json(build(req, res)); });
  return (await request(app).post('/').set('Host', '127.0.0.1:3000').type('form').send(body)).body as Record<string, unknown>;
}

const ENDPOINTS = endpointsOf({
  add: { path: '/cart', fields: ['sku', 'qty'], run: () => ({ result: null }) },
  checkout: { path: '/checkout', run: () => ({ result: null }) },
});

describe('the view parts', () => {
  it('baseView needs no shop: header data, message, curl, endpoints and api; no wallet unless given', async () => {
    const d = await built('templar', {}, (req, res) => baseView(req, res, {
      result: null, curl: { path: '/wallet/buy', signIn: false }, endpoints: ENDPOINTS,
    }));
    expect(d).toEqual({
      base: LAB, served: 'templar', customer: { username: 'pilgrim', id: 'C-1042', email: 'pilgrim@relic-market.test' },
      wallet: null, result: null, kept: { intent: '', sku: '', qty: '' }, api: [],
      endpoints: [
        { method: 'POST', path: '/cart', href: `${LAB}/cart?level=templar`, fields: ['sku', 'qty'] },
        { method: 'POST', path: '/checkout', href: `${LAB}/checkout?level=templar`, fields: [] },
      ],
      curl: { url: `http://127.0.0.1:3000${LAB}/wallet/buy?level=templar`, method: '', headers: [], cookies: [], data: '', form: [], signIn: false },
    });
    const withWallet = await built('templar', {}, (req, res) => baseView(req, res, { result: null, curl: { path: '/' }, wallet: 1234 }));
    expect(withWallet.wallet).toEqual({ cents: 1234, text: '$12.34' });
  });

  it('the catalog, cart and orders parts are shopView\'s pieces, each on its own', async () => {
    const whole = await viewData('acolyte');
    const parts = await built('acolyte', {}, (req) => {
      const state = fixtureShop();
      return {
        ...catalogView(req, state, { fields: (p) => ({ price: String(p.price) }) }),
        ...cartView(state, exactTotals(state)),
        ...ordersView(req, state, { challenge: C, proves }),
      };
    });
    expect(parts.catalog).toEqual(whole.catalog);
    expect(parts.cart).toEqual(whole.cart);
    expect((parts.orders as { flag: string }[]).map((o) => o.flag)).toEqual((whole.orders as { flag: string }[]).map((o) => o.flag));
  });

  it('a product form keeps the typed quantity only after an add (the intent that ran, else the body\'s intent)', async () => {
    const typed = { sku: 'CANDLE', qty: '7' };
    const qtys = async (body: object, intent?: string) => {
      const d = await built('acolyte', body, (req) => catalogView(req, fixtureShop(), intent === undefined ? {} : { intent }));
      return (d.catalog as { qty: string }[]).map((p) => p.qty);
    };
    expect(await qtys(typed, 'add')).toEqual(['1', '7']); // named path /cart: no intent field, mountIntents names it
    expect(await qtys({ ...typed, intent: 'add' })).toEqual(['1', '7']);
    expect(await qtys(typed, 'return')).toEqual(['1', '1']);
    expect(await qtys({ ...typed, intent: 'return' })).toEqual(['1', '1']);
    expect(await qtys(typed)).toEqual(['1', '1']);
    const d = await built('acolyte', typed, (req, res) => baseView(req, res, { result: null, curl: { path: '/' }, intent: 'return' }));
    expect(d.kept).toEqual({ intent: 'return', sku: 'CANDLE', qty: '7' });
  });

  it('the header shows the wallet only when there is one; the endpoint list is one line, or nothing', async () => {
    const noWallet = await built('acolyte', {}, (req, res) => baseView(req, res, { result: null, curl: { path: '/' }, endpoints: ENDPOINTS }));
    const header = await renderFile(views('shop-header'), { ...noWallet, heading: 'Relic Market' }, opts);
    expect(header).toContain('Signed in as <code>pilgrim</code>');
    expect(header).not.toContain('data-testid="wallet"');
    const list = await renderFile(views('endpoints'), noWallet, opts);
    expect(list).toContain(`Endpoints: <code>POST ${LAB}/cart?level=acolyte</code> (sku, qty); <code>POST ${LAB}/checkout?level=acolyte</code>.`);
    expect(list).toContain(`with a hidden <code>intent</code>`);
    expect(list.trim().split('\n')).toHaveLength(1);
    const none = await built('acolyte', {}, (req, res) => baseView(req, res, { result: null, curl: { path: '/' } }));
    expect((await renderFile(views('endpoints'), none, opts)).trim()).toBe('');
  });
});

describe('removeLineIntent', () => {
  it('removes the one line named by sku and kind (a return line is its own), and refuses a line not in the cart', async () => {
    const state = fixtureShop(); // CANDLE x3, RELIQUARY return x -25
    setLine(state, { sku: 'RELIQUARY', qty: 1, unitPrice: 100000 });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    const r = Router();
    const intent = removeLineIntent(() => state);
    expect(intent).toMatchObject({ path: '/cart/remove', fields: ['sku', 'kind'] });
    mountIntents(r, { remove: intent }, async (_req, res, o) => { res.json(o.result); });
    app.use('/lab', r);
    const send = async (body: object) => (await request(app).post('/lab/cart/remove').send(body)).body as unknown;
    expect(await send({ sku: 'RELIQUARY', kind: 'return' })).toEqual({ ok: true, text: 'Removed Reliquary <of> "Saints" (return) from your cart.' });
    expect(state.cart.map((l) => [l.sku, l.kind ?? ''])).toEqual([['CANDLE', ''], ['RELIQUARY', '']]);
    for (const body of [{ sku: 'RELIQUARY', kind: 'return' }, { sku: 'GRAIL' }, { sku: ['CANDLE'] }, {}]) {
      expect(await send(body), JSON.stringify(body)).toEqual({ ok: false, text: 'That line is not in your cart.' });
    }
    expect(await send({ sku: 'CANDLE', kind: ['return'] })).toEqual({ ok: true, text: 'Removed Votive Candle from your cart.' });
    expect(state.cart.map((l) => l.sku)).toEqual(['RELIQUARY']);
  });

  it('a removable cart renders one Remove form per line, posting back with intent=remove, its sku and kind', async () => {
    const d = await built('acolyte', {}, () => cartView(fixtureShop(), exactTotals(fixtureShop()), { removable: true }));
    const html = await renderFile(views('cart'), d, opts);
    const forms = [...html.matchAll(/<form method="post">([\s\S]*?)<\/form>/g)].map((m) => m[1]).filter((f) => f.includes('value="remove"'));
    expect(forms).toHaveLength(2);
    expect(forms[1]).toContain('<input type="hidden" name="sku" value="RELIQUARY">');
    expect(forms[1]).toContain('<input type="hidden" name="kind" value="return">');
    const fixed = await renderFile(views('cart'), await built('acolyte', {}, () => cartView(fixtureShop(), exactTotals(fixtureShop()))), opts);
    expect(fixed).not.toContain('value="remove"');
  });
});

describe('shop partials', () => {
  it('render the machine-readable hooks the test kit reads back', async () => {
    const html = await renderAll(await viewData('acolyte'));
    expect(walletOf(html)).toBe(-1050);
    expect(html).toContain('Signed in as <code>pilgrim</code>');
    expect(cartOf(html)).toEqual([
      { sku: 'CANDLE', qty: 3, line: 750, kind: '' },
      { sku: 'RELIQUARY', qty: -25, line: -2500000, kind: 'return' },
    ]);
    const orders = ordersOf(html);
    expect(orders.map(({ no, total, charged, status }) => ({ no, total, charged, status }))).toEqual([
      { no: 2, total: 500, charged: 500, status: 'paid' },
      { no: 1, total: 0, charged: 0, status: 'paid' },
    ]);
    expect(orders[0].flag).toBeUndefined();
    expect(orders[1].flag).toBe(flagFor(at('acolyte'), C));
    expect(productForm(html, 'CANDLE')).toEqual({ intent: 'add', sku: 'CANDLE', price: '250', qty: '1' });
    expect(html).toContain(`href="${LAB}/api/price-lists?level=acolyte"`);
  });

  it('show negative lines honestly and escape everything', async () => {
    const html = await renderAll(await viewData('acolyte', { intent: 'add', sku: 'CANDLE', qty: '"><script>alert(1)</script>' }));
    expect(html).toMatch(/× -25[\s\S]{0,80}-\$25,000\.00/);
    expect(html).toContain('-$10.50');
    expect(html).toContain('Reliquary &lt;of&gt; &#34;Saints&#34;');
    expect(html).toContain('A relic &amp; more.');
    expect(html).toContain('Hello &lt;b&gt;');
    expect(html).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toContain('<script>');
    expect(html).toMatch(/class="lab-message lab-success"[^>]*>Hello/);
  });

  it('every form posts back with no action and carries its intent', async () => {
    const html = await renderAll(await viewData('acolyte'));
    const forms = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)];
    expect(forms.length).toBeGreaterThanOrEqual(3); // two products + checkout
    for (const [tag, inner] of forms) {
      expect(tag).toMatch(/^<form method="post">/);
      expect(inner).toMatch(/<input type="hidden" name="intent" value="[a-z]+">/);
    }
    expect(html).not.toMatch(/type="password"/);
  });

  it('an empty cart, no orders and no api render as notes', async () => {
    const app = express();
    app.use((req, res, next) => { req.level = 'divine'; req.sessionId = 's'; res.locals.labPath = LAB; next(); });
    app.get('/', (req, res) => {
      const s = newShop({ catalog: CATALOG, wallet: 0 });
      res.json(shopView(req, res, s, { challenge: C, result: null, proves, curl: { path: '/cart' }, totals: exactTotals(s) }));
    });
    const html = await renderAll((await request(app).get('/')).body as Record<string, unknown>);
    expect(html).toContain('Nothing in your cart yet.');
    expect(html).toContain('No orders yet.');
    expect(cartOf(html)).toEqual([]);
    expect(ordersOf(html)).toEqual([]);
    expect(html).not.toContain('data-testid="lab-message"');
    expect(html).not.toContain('<h2>API</h2>');
  });

  it('staff-code.ejs: a redeem form with intent=redeem, the length, and the typed code kept escaped', async () => {
    const html = await renderFile(views('staff-code'), { noun: 'staff code', length: 8, code: '"><b>' }, opts);
    expect(html).toMatch(/<form method="post">/);
    expect(html).toContain('<input type="hidden" name="intent" value="redeem">');
    expect(html).toContain('Redeem staff code (8 characters)');
    expect(html).toContain('name="code" type="text"');
    expect(html).toContain('value="&#34;&gt;&lt;b&gt;"');
  });
});

describe('batch D shell support: the orders list, string ids and parameterised API paths', () => {
  const foreign = (no: number | string, owner: string): Order => ({
    no, owner, lines: [{ sku: 'RELIQUARY', name: 'Reliquary', qty: 1, unitPrice: 1, listPrice: 100000 }], discounts: [],
    subtotal: 1, total: 1, charged: 1, status: 'shipped', at: 0,
  });
  const mixedShop = (): ShopState => {
    const s = fixtureShop();
    pinOrder(s, foreign(1002, 'C-1043'));
    pinOrder(s, foreign('ORD-ABCDEFGHIJ', 'C-1042'));
    s.orders.push(foreign(9001, 'C-1044')); // a foreign order even in the player's own list is never shown
    return s;
  };

  it('ordersView lists only the signed-in customer orders (pinned ones included), newest first, with string ids', async () => {
    const d = await built('acolyte', {}, (req) => ordersView(req, mixedShop(), { challenge: C, proves }));
    expect((d.orders as { no: number | string }[]).map((o) => o.no)).toEqual([2, 1, 'ORD-ABCDEFGHIJ']);
  });

  it('shopView shows no order of another customer in the page', async () => {
    const d = await built('acolyte', {}, (req, res) => {
      const state = mixedShop();
      return shopView(req, res, state, { challenge: C, result: null, proves, curl: { path: '/cart' }, totals: exactTotals(state) });
    });
    const html = await renderAll(d);
    expect(orderIdsOf(html)).toEqual(['2', '1', 'ORD-ABCDEFGHIJ']);
    expect(html).not.toContain('1002');
    expect(html).not.toContain('9001');
  });

  it('the checkout form of the cart posts the intent the lab names (default checkout), for a multi-step checkout', async () => {
    const html = async (o: { checkoutIntent?: string }) => {
      const d = await built('acolyte', {}, (_req) => {
        const state = fixtureShop();
        return { ...cartView(state, exactTotals(state), o), heading: 'x' };
      });
      return renderFile(views('cart'), d, opts);
    };
    expect(await html({})).toContain('<input type="hidden" name="intent" value="checkout">');
    const start = await html({ checkoutIntent: 'start' });
    expect(start).toContain('<input type="hidden" name="intent" value="start">');
    expect(start).not.toContain('value="checkout"');
  });

  it('an API endpoint with a parameter links to its example, and has no link without one', async () => {
    const d = await built('inquisitor', {}, (req, res) => baseView(req, res, {
      result: null, curl: { path: '/api/orders/1' },
      api: [
        { path: '/api/price-lists', description: 'plain' },
        { path: '/api/orders/:id', example: '/api/orders/ORD-1', description: 'one order' },
        { path: '/api/orders?ids=a,b', example: '/api/orders?ids=ORD-1,ORD-2', description: 'several' },
        { path: '/api/things/:id', description: 'no example' },
      ],
    }));
    expect(d.api).toEqual([
      { method: 'GET', path: '/api/price-lists', href: `${LAB}/api/price-lists?level=inquisitor`, description: 'plain' },
      { method: 'GET', path: '/api/orders/:id', href: `${LAB}/api/orders/ORD-1?level=inquisitor`, description: 'one order' },
      { method: 'GET', path: '/api/orders?ids=a,b', href: `${LAB}/api/orders?ids=ORD-1,ORD-2&level=inquisitor`, description: 'several' },
      { method: 'GET', path: '/api/things/:id', href: '', description: 'no example' },
    ]);
    const html = await renderFile(views('api'), d, opts);
    expect(html).toContain(`<a href="${LAB}/api/orders/ORD-1?level=inquisitor">/api/orders/:id</a>`);
    expect(html).toContain('<code>GET /api/things/:id</code>: no example');
    expect(html).not.toContain('href=""');
  });
});
