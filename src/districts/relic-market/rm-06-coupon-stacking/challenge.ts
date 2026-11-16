// challenge.ts — RM-06 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { addDiscount, exactTotals, formatMoney, insufficientFunds, orderLines, placeOrder, setLine } from '../_shared/shop.js';
import {
  endpointsOf, mountIntents, refusal, removeLineIntent, shopView, success, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import { CATALOG, COUPONS, labFor, listSubtotal, proves, resetLab, walk, type CouponLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<CouponLevel>({ acolyte, templar, inquisitor, divine });

const QTY = /^\d{1,2}$/;

/** Add to cart: a quantity is 1 to 99 and the price is the server catalog's, at every level (the flaw is the promotions). */
function add(req: Request): Outcome {
  const p = CATALOG.get(field(req, 'sku'));
  if (p === undefined) return refusal('Unknown product.');
  const raw = field(req, 'qty');
  const qty = QTY.test(raw) ? Number(raw) : 0;
  if (qty < 1) return refusal('Quantity must be a whole number from 1 to 99.');
  return { result: setLine(labFor(req), { sku: p.sku, qty, unitPrice: p.price }) };
}

/** Apply a promotion code: the level decides which code(s) the cart holds afterwards. */
function applyCoupon(req: Request): Outcome {
  return { result: impl.for(req.level).applyCoupon(labFor(req), req.body) };
}

/** Remove promotions (plumbing at every level): the cart holds none afterwards. */
function removeCoupons(req: Request): Outcome {
  labFor(req).coupons.length = 0;
  return success('Promotions removed.');
}

/**
 * Checkout (plumbing at every level): the applied codes are walked over the cart's LIST subtotal (model.ts walk), the
 * discounts are recorded on the order, and the wallet must cover what remains.
 */
function checkout(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const subtotal = listSubtotal(state);
  const { steps, total } = walk(subtotal, state.coupons);
  if (total > state.wallet) return refusal(insufficientFunds(total, state.wallet));
  state.discounts.length = 0;
  for (const s of steps) addDiscount(state, s);
  const order = placeOrder(state, { lines: orderLines(state), subtotal, total, charged: total });
  if (typeof order === 'string') { state.discounts.length = 0; return refusal(order); }
  state.coupons.length = 0;
  return success(`Order #${order.no} placed. Charged ${formatMoney(order.charged)}; your wallet now holds ${formatMoney(state.wallet)}.`);
}

/** The page's actions: POST / with a hidden intent, or each one's own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add },
  remove: removeLineIntent(labFor),
  coupon: { path: '/cart/coupon', fields: ['code'], run: applyCoupon },
  uncoupon: { path: '/cart/uncoupon', run: removeCoupons },
  checkout: { path: '/checkout', run: checkout },
};

const money = (cents: number) => ({ cents, text: formatMoney(cents) });

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const { steps, total } = walk(listSubtotal(state), state.coupons);
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM06, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves, removable: true,
    endpoints: endpointsOf(INTENTS), curl: { path: '/cart/coupon', form: { code: 'WELCOME10' }, signIn: false },
    extra: {
      promotions: [...COUPONS].map(([code, c]) => ({ code, blurb: c.blurb })),
      applied: steps.map((s) => ({ code: s.code, amount: money(s.amount) })),
      payable: money(total),
      codeKept: outcome.intent === 'coupon' ? field(req, 'code') : '',
    },
  }));
}

export const RM06 = register(defineChallenge({
  id: 'RM-06', district: 'relic-market', slug: 'coupon-stacking', dir,
  title: { id: 'Menumpuk Kupon', en: 'Coupon Stacking' },
  summary: {
    id: 'Aturannya satu promo per pesanan. Bayar pesanan dengan diskon lebih besar daripada yang bisa diberikan satu promo mana pun.',
    en: 'The rule is one promotion per order. Pay for an order with a bigger discount than any single promotion can give.',
  },
  maps: ['A06:2025', 'CWE-837'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Saat kamu memasukkan kode kedua, apa yang diperiksa server: kode yang sama, atau berapa kode yang sudah ada di keranjang?', en: 'When you enter a second code, what does the server check: the same code, or how many codes the cart already holds?' } },
    { id: 2, cost: 20, text: { id: 'Kalau permintaan kedua ditolak, tanyakan bagaimana server menghitung: per permintaan, atau per kode di dalam permintaan?', en: 'If a second request is refused, ask how the server counts: per request, or per code inside the request?' } },
    { id: 3, cost: 40, text: { id: 'Bisakah satu field formulir membawa lebih dari satu nilai? Bagaimana body parser mengubah field yang diulang atau berbentuk array?', en: 'Can one form field carry more than one value? How does the body parser turn a repeated or array-shaped field into data?' } },
  ],
  // Restart: a spent wallet otherwise sticks for 26 h. No limiter or budget here, and the proof is measured against
  // this instance's own orders, so a fresh shop helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
