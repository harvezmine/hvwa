// challenge.ts — RM-14 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { formatMoney, orderLines, placeOrder, setLine, type CartTotals } from '../_shared/shop.js';
import { mountIntents, refusal, shopView, success, type Outcome } from '../_shared/shop-lab.js';
import { CATALOG, labFor, proves, resetLab, type IntLevel, type LabState } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<IntLevel>({ acolyte, templar, inquisitor, divine });

/** The cart exactly as the level computes it: each line's total, folded into the cart total with addToTotal. */
function totalsOf(level: IntLevel, state: LabState): CartTotals {
  let total = 0;
  let refused: string | undefined;
  const lines = state.cart.map((line) => {
    const t = level.lineTotal(line.unitPrice, line.qty);
    if (typeof t === 'string') refused ??= t;
    else total = level.addToTotal(total, t);
    return { line, total: t };
  });
  return { lines, total: refused ?? total };
}

/** Add to cart (sets the SKU's quantity): the level parses it and may refuse the line's total right away. */
function add(req: Request): Outcome {
  const p = CATALOG.get(field(req, 'sku'));
  if (p === undefined) return refusal('Unknown product.');
  const level = impl.for(req.level);
  const qty = level.parseQty(field(req, 'qty'));
  if (typeof qty === 'string') return refusal(qty);
  const line = level.lineTotal(p.price, qty);
  if (typeof line === 'string') return refusal(line);
  return { result: setLine(labFor(req), { sku: p.sku, qty, unitPrice: p.price }) };
}

/** Checkout: the order is charged the cart total as the level computed it. */
function checkout(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const level = impl.for(req.level);
  const { total } = totalsOf(level, state);
  if (typeof total === 'string') return refusal(total);
  const ok = level.checkoutAllowed(total, state.wallet);
  if (ok !== true) return refusal(ok);
  const order = placeOrder(state, { lines: orderLines(state), subtotal: total, total, charged: total });
  if (typeof order === 'string') return refusal(order);
  return success(`Order #${order.no} placed. Charged ${formatMoney(order.charged)}; your wallet now holds ${formatMoney(state.wallet)}.`);
}

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM14, result: outcome.result, totals: totalsOf(impl.for(req.level), state), proves,
    curl: { path: '/cart', form: { sku: 'SLIP', qty: '1' } },
  }));
}

export const RM14 = register(defineChallenge({
  id: 'RM-14', district: 'relic-market', slug: 'cart-total-overflow', dir,
  title: { id: 'Integer Overflow pada Total Keranjang', en: 'Integer Overflow in Cart Total' },
  summary: {
    id: 'Bayar pesanan berisi Reliquary ($9,999.00) dengan dompet $50.00 dengan mendorong total keranjang melewati batas integer.',
    en: 'Pay for an order containing the Reliquary ($9,999.00) with a $50.00 wallet by pushing the cart total past an integer limit.',
  },
  // Q2: A05:2025 as in the catalog row; CWE-190 (integer overflow or wraparound) names the weakness.
  maps: ['A05:2025', 'CWE-190'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Total disimpan dalam sen sebagai integer 32-bit bertanda. Berapa nilai terbesarnya, dan apa yang terjadi satu sen setelahnya?', en: 'The total is kept in cents as a signed 32-bit integer. What is its largest value, and what happens one cent past it?' } },
    { id: 2, cost: 20, text: { id: 'Templar menolak total yang tidak positif. Bagaimana kuantitas itu sendiri disimpan, dan bisakah kamu membuat total mendarat sedikit di atas nol setelah membungkus?', en: 'Templar refuses totals that are not positive. How is the quantity itself stored, and can you make the total land just above zero after it wraps?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor setiap baris diperiksa agar muat. Apakah jumlah semua baris juga diperiksa?', en: 'At Inquisitor each line is checked to fit. Is the sum of the lines checked too?' } },
  ],
  // Restart: a spent wallet otherwise sticks for 26 h. No limiter or budget here, and the proof is measured against
  // this instance's own orders, so a fresh shop helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, {
      add: { path: '/cart', run: add },
      checkout: { path: '/checkout', run: checkout },
    }, render);
  },
}));
