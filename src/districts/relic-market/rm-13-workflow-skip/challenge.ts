// challenge.ts — RM-13 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import {
  CUSTOMER, cartTotal, clipText, exactTotals, formatMoney, orderLines, pushOrder, setLine, type Order,
} from '../_shared/shop.js';
import {
  endpointsOf, flagLine, mountIntents, refusal, removeLineIntent, shopView, success, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import {
  CATALOG, addCheckout, findCheckout, labFor, newCheckoutId, proves, resetLab, stepCookie, type CheckoutFlow, type FlowLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const impl = byLevel<FlowLevel>({ acolyte, templar, inquisitor, divine });

const UNKNOWN = 'Unknown checkout.';
const ALREADY_PAID = 'This checkout is already paid.';

/** The checkout the request names (`checkout` field), or undefined. */
const flowOf = (req: Request): CheckoutFlow | undefined => findCheckout(labFor(req), field(req, 'checkout'));

/** Quantities are not this lab's lesson: 1 to 99 at every level (plumbing). */
function parseQty(raw: string): number | string {
  const n = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
  return n >= 1 ? n : 'Quantity must be a whole number from 1 to 99.';
}

/** Add to cart: the SKU is checked against the catalog, the price is the server's. */
function add(req: Request): Outcome {
  const p = CATALOG.get(field(req, 'sku'));
  if (p === undefined) return refusal('Unknown product.');
  const qty = parseQty(field(req, 'qty'));
  if (typeof qty === 'string') return refusal(qty);
  return { result: setLine(labFor(req), { sku: p.sku, qty, unitPrice: p.price }) };
}

/** Step 1, start: the cart becomes a checkout (created), and the cart is empty again. */
function start(req: Request): Outcome {
  const state = labFor(req);
  if (state.cart.length === 0) return refusal('Your cart is empty.');
  const total = cartTotal(state.cart);
  if (total === undefined || total < 0) return refusal('This cart cannot be checked out.');
  const co: CheckoutFlow = { id: newCheckoutId(), lines: orderLines(state), total, state: 'created', paid: 0, received: 0, declined: false, address: '' };
  addCheckout(state, co);
  state.cart.length = 0;
  return success(`Checkout ${co.id} started for ${formatMoney(total)}.`);
}

/** Step 2, shipping: an address (clipped), created -> shipping. */
function shipping(req: Request): Outcome {
  const co = flowOf(req);
  if (co === undefined) return refusal(UNKNOWN);
  if (co.state === 'paid' || co.state === 'confirmed') return { result: { ok: false, text: ALREADY_PAID }, status: 409 };
  const address = clipText(field(req, 'address'));
  if (address === '') return refusal('Enter a shipping address.');
  co.address = address;
  if (co.state === 'created') co.state = 'shipping';
  return success(`Shipping address saved for checkout ${co.id}.`);
}

/** Step 3, pay: the level pays (Pilgrim Pay), or sends the browser on to the return page. */
function pay(req: Request, res: Response): Outcome {
  const co = flowOf(req);
  if (co === undefined) return refusal(UNKNOWN);
  if (co.state === 'paid' || co.state === 'confirmed') return { result: { ok: false, text: ALREADY_PAID }, status: 409 };
  const out = impl.for(req.level).pay(labFor(req), co);
  if (out.kind === 'redirect') {
    // A lab-local redirect (labPath, never a simulated URL): the return page the provider's answer is carried to.
    res.redirect(303, `${labPath(res)}/checkout/return?checkout=${co.id}&status=${out.status}&level=${req.level}`);
    return { result: null };
  }
  if (out.cookie !== undefined) res.cookie(out.cookie.name, out.cookie.value, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
  return out.result.ok ? { result: out.result } : { result: out.result, status: out.status ?? 402 };
}

/** The cookie the level may keep its payment step in, as a string (cookie-parser turns `j:{...}` into an object). */
function stepCookieOf(req: Request): string | undefined {
  const v: unknown = (req.cookies as Record<string, unknown> | undefined)?.[stepCookie(req.level)];
  return typeof v === 'string' ? v : undefined;
}

/** Step 4, confirm: the level decides; a confirmed checkout becomes one order (the charge recorded is what Pilgrim Pay really took). */
function confirm(req: Request): Outcome {
  const state = labFor(req);
  const co = flowOf(req);
  if (co === undefined) return refusal(UNKNOWN);
  if (co.state === 'confirmed') return success(`Order #${co.orderNo ?? 0} was already confirmed.`);
  const r = impl.for(req.level).confirm(state, co, { stepCookie: stepCookieOf(req) });
  if (!r.ok) return { result: r, status: 402 };
  const order: Order = Object.freeze({
    no: state.nextOrderNo, owner: CUSTOMER.id, lines: co.lines, discounts: Object.freeze([]), subtotal: co.total, total: co.total,
    charged: co.received, status: 'confirmed', at: state.clock.now(),
  });
  state.nextOrderNo += 1;
  pushOrder(state, order);
  co.orderNo = order.no as number;
  const base = `Order #${order.no} confirmed for shipping.`;
  return success(proves(order) ? `${base} ${flagLine(req, RM13)}` : base);
}

const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add },
  remove: removeLineIntent(labFor),
  start: { path: '/checkout/start', run: start },
  shipping: { path: '/checkout/shipping', fields: ['checkout', 'address'], run: shipping },
  pay: { path: '/checkout/pay', fields: ['checkout'], run: pay },
  confirm: { path: '/checkout/confirm', fields: ['checkout'], run: confirm },
};

/** What a checkout panel shows: the state, and which of the four steps really happened (a skipped one stays open). */
function panelOf(co: CheckoutFlow) {
  const paid = (co.state === 'paid' || co.state === 'confirmed') && co.paid > 0;
  return {
    id: co.id, state: co.state, total: formatMoney(co.total), paid: formatMoney(co.paid), address: co.address,
    items: co.lines.map((l) => `${l.name} × ${l.qty}`).join(', '),
    steps: [
      { name: 'Start', done: true },
      { name: 'Shipping', done: co.address !== '' },
      { name: 'Pay', done: paid },
      { name: 'Confirm', done: co.state === 'confirmed' },
    ],
  };
}

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  if (res.headersSent) return; // the pay step already answered with its redirect
  const state = labFor(req);
  await sendPage(res, view, shopView(req, res, state, {
    challenge: RM13, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves, removable: true,
    checkoutIntent: 'start', endpoints: endpointsOf(INTENTS),
    curl: { path: '/checkout/confirm', form: { checkout: '<checkout id>' }, signIn: false },
    extra: { checkouts: [...state.checkouts].reverse().map(panelOf) },
  }));
}

export const RM13 = register(defineChallenge({
  id: 'RM-13', district: 'relic-market', slug: 'workflow-skip', dir,
  title: { id: 'Melewati Langkah Pembayaran', en: 'Workflow Skip (Pay-Step Bypass)' },
  summary: {
    id: 'Buat pesanan Reliquary ($200.00) dikonfirmasi untuk dikirim tanpa benar-benar membayarnya.',
    en: 'Get an order for the Reliquary ($200.00) confirmed for shipping without actually paying for it.',
  },
  maps: ['A06:2025', 'CWE-841'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Checkout punya beberapa langkah. Apakah langkah terakhir memastikan langkah pembayaran benar-benar terjadi?', en: 'Checkout has several steps. Does the last step make sure the payment step really happened?' } },
    { id: 2, cost: 20, text: { id: 'Kalau server mengingat "sudah bayar", di mana ia menyimpannya, dan bisakah kamu menulis di tempat itu sendiri?', en: 'If the server remembers "paid", where does it keep that, and can you write there yourself?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor status pembayaran ada di server. Siapa yang memberi tahu server bahwa pembayaran berhasil, dan bagaimana server tahu pesan itu asli?', en: 'At Inquisitor the payment state lives on the server. Who tells the server that a payment succeeded, and how does it know the message is genuine?' } },
  ],
  // Restart: a spent wallet or a wedged checkout otherwise sticks for 26 h. No limiter or budget here, and the proof is
  // measured against this instance's own orders, so a fresh shop (and a fresh provider key) helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });

    // The provider's return page: the browser arrives here after paying. What the server makes of the query is the level's.
    router.get('/checkout/return', async (req, res) => {
      const state = labFor(req);
      const id = typeof req.query.checkout === 'string' ? req.query.checkout : '';
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const co = findCheckout(state, id);
      if (co === undefined) {
        res.status(404);
        await render(req, res, refusal(UNKNOWN));
        return;
      }
      await render(req, res, { result: impl.for(req.level).paymentReturn(state, co, status) });
    });

    mountIntents(router, INTENTS, render);
  },
}));
