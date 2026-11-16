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
import { catalogOf, exactTotals, newShop, placeOrder, orderLines, setLine, type Order, type ShopState } from './shop.js';
import { flagLine, mountIntents, shopView, welcome, type Intent, type Outcome } from './shop-lab.js';
import { redeemCode } from './staff-code.js';
import { cartOf, ordersOf, productForm, walletOf } from './shop-lab.testkit.js';

const C = { id: 'RX-01', levels: ['acolyte', 'templar', 'divine'] as const satisfies readonly Level[] };
const at = (level: Level) => ({ sessionId: 'sid-shell', level });

describe('mountIntents', () => {
  const runs: string[] = [];
  const intents: Record<string, Intent> = {
    add: { path: '/cart', run: (req) => { runs.push(`add ${String((req.body as { sku?: unknown }).sku)}`); return { result: { ok: true, text: 'Added.' } }; } },
    checkout: { path: '/checkout', run: async () => ({ result: { ok: false, text: 'Refused.' }, status: 402 }) },
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const router = Router();
  mountIntents(router, intents, async (req: Request, res: Response, o: Outcome) => { res.json({ path: req.path, result: o.result }); });
  app.use('/lab', router);

  it('POST / dispatches on the intent field; each intent also has its own path', async () => {
    const root = await request(app).post('/lab').type('form').send({ intent: 'add', sku: 'CANDLE' });
    expect(root.status).toBe(200);
    expect(root.body).toEqual({ path: '/', result: { ok: true, text: 'Added.' } });
    const named = await request(app).post('/lab/cart').type('form').send({ sku: 'ROSARY' });
    expect(named.body).toEqual({ path: '/cart', result: { ok: true, text: 'Added.' } });
    expect(runs).toEqual(['add CANDLE', 'add ROSARY']);
  });

  it('an outcome status is the response status, on both doors', async () => {
    expect((await request(app).post('/lab').type('form').send({ intent: 'checkout' })).status).toBe(402);
    expect((await request(app).post('/lab/checkout')).status).toBe(402);
  });

  it('a missing, unknown, inherited or non-string intent answers 200 "Unknown action." and runs nothing', async () => {
    runs.length = 0;
    const bodies: object[] = [{}, { intent: 'nope' }, { intent: 'constructor' }, { intent: '__proto__' }, { intent: 'toString' },
      { intent: ['add'] }, { intent: { add: 1 } }, []];
    for (const body of bodies) {
      const res = await request(app).post('/lab').send(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.result, JSON.stringify(body)).toEqual({ ok: false, text: 'Unknown action.' });
    }
    expect(runs).toEqual([]);
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
      total: { cents: -2499250, text: '-$24,992.50' }, note: '',
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
    expect(d.kept).toEqual({ sku: 'CANDLE', qty: '"><x' });
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
      total: null, note: 'out of range',
    });
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
