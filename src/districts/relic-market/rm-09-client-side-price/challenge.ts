// challenge.ts — RM-09 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { exactTotals, formatMoney, insufficientFunds, orderLines, placeOrder, setLine, type Product } from '../_shared/shop.js';
import {
  endpointsOf, mountIntents, refusal, removeLineIntent, shopView, success, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import { CATALOG, PRICE_LISTS, labFor, listPrice, parseQty, proves, resetLab, type PriceLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<PriceLevel>({ acolyte, templar, inquisitor, divine });
const productNamed = (sku: string): Product => {
  const p = CATALOG.get(sku);
  if (p === undefined) throw new Error(`RM-09: the catalog has no ${sku}`);
  return p;
};
/** The curl example's product. */
const CANDLE = productNamed('CANDLE');

/** Add to cart: the SKU is checked against the catalog, the quantity is 1-99, and the level decides the unit price. */
function add(req: Request): Outcome {
  const state = labFor(req);
  const p = CATALOG.get(field(req, 'sku'));
  if (p === undefined) return refusal('Unknown product.');
  const qty = parseQty(field(req, 'qty'));
  if (typeof qty === 'string') return refusal(qty);
  const unitPrice = impl.for(req.level).unitPrice(p, req, state.account);
  if (typeof unitPrice === 'string') return refusal(unitPrice);
  return { result: setLine(state, { sku: p.sku, qty, unitPrice }) }; // the route stores what the level priced
}

/** Checkout (plumbing at every level): the cart total, which must be 0 or more and covered by the wallet. */
function checkout(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const { total } = exactTotals(state);
  if (typeof total === 'string') return refusal(total);
  if (total < 0) return refusal('The order total cannot be negative.');
  if (total > state.wallet) return refusal(insufficientFunds(total, state.wallet));
  const order = placeOrder(state, { lines: orderLines(state), subtotal: total, total, charged: total });
  if (typeof order === 'string') return refusal(order);
  return success(`Order #${order.no} placed. Charged ${formatMoney(order.charged)}; your wallet now holds ${formatMoney(state.wallet)}.`);
}

/** The page's actions: POST / with a hidden intent, or each one's own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add },
  remove: removeLineIntent(labFor),
  checkout: { path: '/checkout', run: checkout },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const level = impl.for(req.level);
  // The endpoint list names the add-to-cart form's hidden fields of the served level too.
  const hidden = Object.keys(level.formFields(CANDLE));
  const endpoints = endpointsOf(INTENTS).map((e) => (e.intent === 'add' ? { ...e, fields: [...e.fields, ...hidden] } : e));
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM09, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves, removable: true,
    fields: (p) => level.formFields(p), endpoints,
    curl: { path: '/cart', form: { sku: 'CANDLE', qty: '1', ...level.formFields(CANDLE) }, signIn: false },
    api: [{ path: '/api/price-lists', description: 'every price list with its percentage of retail and its prices (JSON)' }],
    extra: { account: state.account },
  }));
}

export const RM09 = register(defineChallenge({
  id: 'RM-09', district: 'relic-market', slug: 'client-side-price', dir,
  title: { id: 'Manipulasi Harga di Sisi Klien', en: 'Client-Side Price Manipulation' },
  summary: {
    id: 'Bayar Reliquary ($500.00) dengan dompet $25.00 dengan mengubah apa yang dikirim browsermu.',
    en: 'Pay for the Reliquary ($500.00) with a $25.00 wallet by changing what your browser sends.',
  },
  maps: ['A06:2025', 'CWE-602', 'CWE-472'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Buka formulir "Add to cart" di devtools. Field tersembunyi apa yang ikut terkirim bersama SKU, dan apakah server memercayainya?', en: 'Open the "Add to cart" form in devtools. Which hidden fields travel with the SKU, and does the server trust them?' } },
    { id: 2, cost: 20, text: { id: 'Checksum tanpa rahasia bisa dihitung oleh siapa saja. Dari bagian mana checksum itu dibuat?', en: 'A checksum without a secret can be computed by anyone. What is it made from?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor harga dihitung di server. Tetapi siapa yang memilih daftar harga mana yang dipakai?', en: 'At Inquisitor the price is computed on the server. But who chooses which price list it uses?' } },
  ],
  // Restart: a spent wallet otherwise sticks for 26 h. No limiter or budget here, and the proof is measured against
  // this instance's own orders, so a fresh shop helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    // Public at every level: nothing about the lists is secret; only Inquisitor lets the client pick one.
    router.get('/api/price-lists', (_req, res) => {
      res.json({
        currency: 'USD', unit: 'cents',
        lists: PRICE_LISTS.map((l) => ({ ...l, prices: Object.fromEntries(CATALOG.products.map((p) => [p.sku, listPrice(p, l)])) })),
      });
    });
    mountIntents(router, INTENTS, render);
  },
}));
