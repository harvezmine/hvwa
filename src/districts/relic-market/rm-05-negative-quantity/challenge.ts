// challenge.ts — RM-05 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { exactTotals, formatMoney, orderLines, placeOrder, setLine } from '../_shared/shop.js';
import {
  endpointsOf, mountIntents, refusal, removeLineIntent, shopView, success, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import { CATALOG, labFor, proves, resetLab, type LabState, type QtyLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<QtyLevel>({ acolyte, templar, inquisitor, divine });

/** The catalog product a form names: every route checks the SKU before a level sees it. */
const productOf = (req: Request) => CATALOG.get(field(req, 'sku'));

/** Add to cart: the level parses the quantity; the price is the server catalog's at every level. */
function add(req: Request): Outcome {
  const p = productOf(req);
  if (p === undefined) return refusal('Unknown product.');
  const qty = impl.for(req.level).parseQty(field(req, 'qty'));
  if (typeof qty === 'string') return refusal(qty);
  return { result: setLine(labFor(req), { sku: p.sku, qty, unitPrice: p.price }) };
}

/** Return for store credit: a return line of -n at the catalog price, added to any return of that SKU in the cart. */
function giveBack(req: Request): Outcome {
  const state = labFor(req);
  const p = productOf(req);
  if (p === undefined) return refusal('Unknown product.');
  const level = impl.for(req.level);
  const n = level.parseQty(field(req, 'qty'));
  if (typeof n === 'string') return refusal(n);
  const ok = level.returnable(state, p.sku, n);
  if (ok !== true) return refusal(ok);
  const pending = state.cart.find((l) => l.sku === p.sku && l.kind === 'return')?.qty ?? 0;
  return { result: setLine(state, { sku: p.sku, qty: pending - n, unitPrice: p.price, kind: 'return' }) };
}

/** Checkout: total = sum of qty x price (a negative total credits the wallet); bought and returned units are booked. */
function checkout(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const { total } = exactTotals(state);
  if (typeof total === 'string') return refusal(total);
  const ok = impl.for(req.level).checkoutAllowed(total, state.wallet);
  if (ok !== true) return refusal(ok);
  const order = placeOrder(state, { lines: orderLines(state), subtotal: total, total, charged: total });
  if (typeof order === 'string') return refusal(order);
  for (const l of order.lines) {
    // Book only what really changed hands: units bought (a purchase line above 0), units returned (a return line below 0).
    const units = l.kind === 'return' ? -l.qty : l.qty;
    if (units <= 0) continue;
    const book = l.kind === 'return' ? state.returned : state.owned;
    book.set(l.sku, (book.get(l.sku) ?? 0) + units);
  }
  return success(`Order #${order.no} placed. Charged ${formatMoney(order.charged)}; your wallet now holds ${formatMoney(state.wallet)}.`);
}

/** The items the return form offers: what the player has bought (how many may go back is the level's decision). */
const ownedRows = (state: LabState) => CATALOG.products
  .map((p) => ({ sku: p.sku, name: p.name, owned: state.owned.get(p.sku) ?? 0, returned: state.returned.get(p.sku) ?? 0 }))
  .filter((o) => o.owned > 0);

/** The page's actions: POST / with a hidden intent, or each one's own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add },
  return: { path: '/cart/return', fields: ['sku', 'qty'], run: giveBack },
  remove: removeLineIntent(labFor),
  checkout: { path: '/checkout', run: checkout },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const owned = ownedRows(state);
  const keptSku = field(req, 'sku');
  // The return form keeps what was typed only after a return of an item it lists.
  const returnQty = outcome.intent === 'return' && owned.some((o) => o.sku === keptSku) ? field(req, 'qty') : '1';
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM05, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves, removable: true,
    endpoints: endpointsOf(INTENTS), curl: { path: '/cart', form: { sku: 'ROSARY', qty: '1' }, signIn: false },
    extra: { owned, returnQty },
  }));
}

export const RM05 = register(defineChallenge({
  id: 'RM-05', district: 'relic-market', slug: 'negative-quantity', dir,
  title: { id: 'Celah Logika Kuantitas Negatif', en: 'Negative Quantity Logic Flaw' },
  summary: {
    id: 'Bayar pesanan berisi Reliquary of the First Pilgrim ($1,000.00) padahal dompetmu hanya $50.00.',
    en: 'Pay for an order containing the Reliquary of the First Pilgrim ($1,000.00) with only $50.00 in your wallet.',
  },
  maps: ['A06:2025', 'CWE-1284', 'CWE-840'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Total pesanan adalah jumlah dari kuantitas kali harga. Angka apa saja yang diterima server sebagai kuantitas?', en: 'The order total is quantity times price, summed. Which numbers does the server accept as a quantity?' } },
    { id: 2, cost: 20, text: { id: 'Filter Templar melihat karakter pertama teks kuantitas. Apakah pengurai angka juga mulai membaca dari karakter itu?', en: 'Templar\'s filter looks at the first character of the quantity text. Does the number parser start reading at that same character?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor kuantitas sudah selalu positif. Fitur mana yang sengaja menambahkan baris bernilai negatif, dan apa yang lupa dihitungnya?', en: 'At Inquisitor quantities are always positive. Which feature adds a negative line on purpose, and what does it forget to count?' } },
  ],
  // Restart: a spent wallet otherwise sticks for 26 h. No limiter or budget here, and the proof is measured against
  // this instance, so a fresh shop helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
