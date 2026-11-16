// challenge.ts — RM-11 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { CUSTOMER, formatMoney } from '../_shared/shop.js';
import {
  baseView, endpointsOf, mountIntents, ordersView, refusal, type Intent, type Outcome,
} from '../_shared/shop-lab.js';
import {
  CUSTOMERS, findOrder, labFor, proves, type Channel, type OrdersLevel, type PlacedOrder,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'shop.ejs');
const orderView = join(dir, 'views', 'order.ejs');
const impl = byLevel<OrdersLevel>({ acolyte, templar, inquisitor, divine });

/** The most ids one batch request names (platform safety: the response stays small at every level). */
const BATCH_MAX = 10;
const DENIED = 'Forbidden: this order belongs to another customer.';
const NOT_FOUND = 'Order not found.';

/** What one lookup came to: the order, or why it was refused (a refusal is a missing order where the level says so). */
type Lookup = { readonly ok: true; readonly order: PlacedOrder } | { readonly ok: false; readonly status: 403 | 404; readonly message: string };

/** The refusal of a level: 403 below Divine, the same answer as a missing order at Divine. */
function refused(req: Request): Extract<Lookup, { ok: false }> {
  return impl.for(req.level).uniformNotFound ? { ok: false, status: 404, message: NOT_FOUND } : { ok: false, status: 403, message: DENIED };
}

/** One order through one door: the level decides access (ownership is the session's customer, never the request's). */
function lookupOne(req: Request, id: string, channel: Channel): Lookup {
  const order = findOrder(labFor(req), id);
  if (order === undefined) return { ok: false, status: 404, message: NOT_FOUND };
  return impl.for(req.level).canRead(CUSTOMER.id, order, channel) ? { ok: true, order } : refused(req);
}

/** The flag for an order that is not the customer's (never at Divine, which serves none): the proof of a foreign read. */
const flagOf = (req: Request, order: PlacedOrder): string | undefined => (proves(order) && req.level !== 'divine' ? flagFor(req, RM11) : undefined);

/** What a page shows of one order (the detail partial's data). */
function detailOf(req: Request, order: PlacedOrder) {
  const flag = flagOf(req, order);
  return {
    id: order.no, customer: order.owner, placedBy: CUSTOMERS[order.owner] ?? order.owner, status: order.status, city: order.city,
    gift: order.gift, total: formatMoney(order.total), flag: flag === undefined ? '' : `Flag: ${flag}`,
    lines: order.lines.map((l) => ({ name: l.name, qty: l.qty, unit: formatMoney(l.unitPrice) })),
  };
}

/** What the API says of one order (the flag is the response's, not the order's). */
function jsonOf(order: PlacedOrder) {
  return {
    id: order.no, customer: order.owner, placedBy: CUSTOMERS[order.owner] ?? order.owner, status: order.status, city: order.city,
    gift: order.gift, total: order.total,
    items: order.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
  };
}

/** What the Find form found, for the render that follows (one per response). */
const found = new WeakMap<Response, Lookup>();

/** Find an order: the page channel's lookup, answered on the page itself. */
function find(req: Request, res: Response): Outcome {
  const id = field(req, 'id');
  if (id === '') return refusal('Enter an order id.');
  const out = lookupOne(req, id, 'page');
  found.set(res, out);
  return out.ok
    ? { result: { ok: true, text: 'Order found.' } }
    : { result: { ok: false, text: out.message }, status: out.status };
}

const INTENTS: Readonly<Record<string, Intent>> = {
  find: { path: '/find', fields: ['id'], run: find },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const level = impl.for(req.level);
  const [a, b] = state.ids.own;
  const lookup = found.get(res);
  await sendPage(res, view, {
    ...baseView(req, res, {
      result: outcome.result, intent: outcome.intent, endpoints: endpointsOf(INTENTS),
      curl: { path: '/api/orders/<your order id>', signIn: false },
      api: [
        { path: '/api/orders/:id', example: `/api/orders/${a}`, description: 'one order (JSON)' },
        { path: '/api/orders?ids=a,b', example: `/api/orders?ids=${a},${b}`, description: `up to ${BATCH_MAX} orders, ids separated by commas (JSON)` },
      ],
    }),
    ...ordersView(req, state, { challenge: RM11, proves }),
    heading: 'Relic Market: your orders',
    detail: lookup?.ok === true ? detailOf(req, lookup.order) : null,
    findId: outcome.intent === 'find' ? field(req, 'id') : '',
    feed: state.records.map((o) => ({ id: level.feedId(o), city: o.city, items: o.lines.map((l) => `${l.name} × ${l.qty}`).join(', ') })),
  });
}

export const RM11 = register(defineChallenge({
  id: 'RM-11', district: 'relic-market', slug: 'idor-orders', dir,
  title: { id: 'IDOR Akses Pesanan', en: 'IDOR Order Access' },
  summary: {
    id: 'Baca pesanan Sister Maren beserta pesan hadiahnya, padahal pesanan itu bukan milikmu.',
    en: 'Read Sister Maren\'s order, gift message included, although it is not yours.',
  },
  maps: ['A01:2025', 'API1:2023', 'CWE-639'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Pesananmu punya nomor di alamatnya. Pesanan siapa yang ada di nomor sebelahnya?', en: 'Your order has a number in its address. Whose order sits at the next number?' } },
    { id: 2, cost: 20, text: { id: 'Id yang tampak acak belum tentu acak. Bisakah kamu mendekode id pesananmu sendiri?', en: 'An id that looks random may not be. Can you decode your own order id?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor setiap pesanan tunggal diperiksa. Bagaimana dengan permintaan yang meminta beberapa pesanan sekaligus: apakah setiap id diperiksa?', en: 'At Inquisitor every single order is checked. What about a request for several orders at once: is every id checked?' } },
  ],
  // No Restart: nothing here is mutated (the orders are seeded and read-only).
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });

    // One order, as a page (the same lookup as the Find form).
    router.get('/orders/:id', async (req, res) => {
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      const out = lookupOne(req, id, 'page');
      res.status(out.ok ? 200 : out.status);
      await sendPage(res, orderView, {
        base: labPath(res), served: req.level, heading: 'Relic Market: order',
        detail: out.ok ? detailOf(req, out.order) : null, message: out.ok ? '' : out.message,
      });
    });

    // One order, as JSON.
    router.get('/api/orders/:id', (req, res) => {
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      const out = lookupOne(req, id, 'api');
      const flag = out.ok ? flagOf(req, out.order) : undefined;
      res.status(out.ok ? 200 : out.status).json(out.ok ? { ...jsonOf(out.order), ...(flag === undefined ? {} : { flag }) } : { error: out.message });
    });

    // Several orders at once: ?ids=a,b (1 to BATCH_MAX ids, given once).
    router.get('/api/orders', (req, res) => {
      const raw = req.query.ids;
      if (typeof raw !== 'string' || raw === '') {
        res.status(400).json({ error: 'Give the ids once, as a comma-separated list: ?ids=a,b.' });
        return;
      }
      const ids = [...new Set(raw.split(','))]; // each id once, in the order given
      if (ids.length > BATCH_MAX) {
        res.status(400).json({ error: `At most ${BATCH_MAX} ids per request.` });
        return;
      }
      const state = labFor(req);
      const orders = impl.for(req.level).authorizeBatch(CUSTOMER.id, ids.map((id) => findOrder(state, id)));
      if (orders === 'deny') {
        const out = refused(req);
        res.status(out.status).json({ error: out.message });
        return;
      }
      if (orders.length === 0) {
        res.status(404).json({ error: NOT_FOUND });
        return;
      }
      const flag = orders.some(proves) && req.level !== 'divine' ? flagFor(req, RM11) : undefined;
      res.json({ orders: orders.map(jsonOf), ...(flag === undefined ? {} : { flag }) });
    });

    mountIntents(router, INTENTS, render);
  },
}));
