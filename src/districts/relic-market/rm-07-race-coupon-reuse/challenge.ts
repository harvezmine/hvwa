// challenge.ts — RM-07 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { exactTotals, formatMoney, insufficientFunds, orderLines, placeOrder, setLine } from '../_shared/shop.js';
import {
  endpointsOf, mountIntents, refusal, removeLineIntent, shopView, success, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import { CATALOG, VOUCHER, labFor, listSubtotal, proves, resetLab, type VoucherLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<VoucherLevel>({ acolyte, inquisitor, divine });

const QTY = /^\d{1,2}$/;

/** Add to cart: a quantity is 1 to 99 and the price is the server catalog's, at every level (the flaw is the voucher). */
function add(req: Request): Outcome {
  const p = CATALOG.get(field(req, 'sku'));
  if (p === undefined) return refusal('Unknown product.');
  const raw = field(req, 'qty');
  const qty = QTY.test(raw) ? Number(raw) : 0;
  if (qty < 1) return refusal('Quantity must be a whole number from 1 to 99.');
  return { result: setLine(labFor(req), { sku: p.sku, qty, unitPrice: p.price }) };
}

/**
 * Apply the voucher. The route arrives at the gate FIRST, then calls the level, with no await in between: arrival and
 * the level's check share one synchronous segment (docs/RECIPES.md section 11). Races only exist in what the level
 * does after that.
 */
async function applyVoucher(req: Request): Promise<Outcome> {
  const state = labFor(req);
  state.gate.arrive();
  return { result: await impl.for(req.level).applyVoucher(state, field(req, 'code')) };
}

/** Checkout (plumbing at every level): the subtotal less every discount on the cart (never below 0), covered by the wallet. */
function checkout(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const subtotal = listSubtotal(state);
  // Platform rule at every level: a cart that no longer meets the voucher's minimum cannot keep its discount.
  if (state.discounts.some((d) => d.code === VOUCHER.code) && subtotal < VOUCHER.min) {
    return refusal(`This voucher needs a subtotal of at least ${formatMoney(VOUCHER.min)}.`);
  }
  const total = Math.max(0, subtotal - state.discounts.reduce((sum, d) => sum + d.amount, 0));
  if (total > state.wallet) return refusal(insufficientFunds(total, state.wallet));
  const order = placeOrder(state, { lines: orderLines(state), subtotal, total, charged: total });
  if (typeof order === 'string') return refusal(order);
  return success(`Order #${order.no} placed. Charged ${formatMoney(order.charged)}; your wallet now holds ${formatMoney(state.wallet)}.`);
}

/** The page's actions: POST / with a hidden intent, or each one's own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add },
  remove: removeLineIntent(labFor),
  voucher: { path: '/cart/voucher', fields: ['code'], run: applyVoucher },
  checkout: { path: '/checkout', run: checkout },
};

const money = (cents: number) => ({ cents, text: formatMoney(cents) });

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const total = Math.max(0, listSubtotal(state) - state.discounts.reduce((sum, d) => sum + d.amount, 0));
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM07, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves, removable: true,
    endpoints: endpointsOf(INTENTS), curl: { path: '/cart/voucher', form: { code: 'FIRSTRELIC' }, signIn: false },
    extra: {
      discounts: state.discounts.map((d) => ({ code: d.code, amount: money(d.amount) })),
      payable: money(total),
      codeKept: outcome.intent === 'voucher' ? field(req, 'code') : '',
    },
  }));
}

export const RM07 = register(defineChallenge({
  id: 'RM-07', district: 'relic-market', slug: 'race-coupon-reuse', dir,
  title: { id: 'Race Condition: Memakai Ulang Kupon', en: 'Race Condition: Coupon Reuse' },
  summary: {
    id: 'Voucher FIRSTRELIC hanya boleh dipakai sekali. Bayar pesanan yang memakainya dua kali.',
    en: 'The FIRSTRELIC voucher may be used once. Pay for an order that uses it twice.',
  },
  maps: ['A06:2025', 'CWE-362', 'CWE-367'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Validasi voucher memakan waktu sekitar satu detik. Kapan tepatnya voucher ditandai sudah dipakai: sebelum atau sesudah jeda itu?', en: 'Validating a voucher takes about a second. When exactly is it marked as used: before or after that pause?' } },
    { id: 2, cost: 20, text: { id: 'Apa yang terjadi bila dua permintaan tiba hampir bersamaan? Alat apa yang bisa mengirim beberapa permintaan sekaligus?', en: 'What happens when two requests arrive at almost the same moment? Which tools can send several requests at once?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor permintaan ganda untuk kode yang sama ditolak. Apakah "kode yang sama" dibandingkan persis seperti yang kamu ketik, atau sesudah dinormalkan?', en: 'At Inquisitor a duplicate request for the same code is refused. Is "the same code" compared exactly as you typed it, or after normalising?' } },
  ],
  // Restart: a spent wallet or voucher otherwise sticks for 26 h. No limiter or budget here (the voucher is the lesson's
  // resource, and a fresh shop has exactly the one it started with), and the proof is measured against this instance.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
