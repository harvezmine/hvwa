// src/districts/relic-market/_shared/shop-lab.ts — the Express side of the Relic Market shop labs: intent dispatch, the
// shared view data and the flag lines. Plumbing only: a lab's routes call its levels/*.ts for every decision (how a
// request becomes a line, what a checkout may charge) and its model.ts for the proof. Not a challenge: nothing here is
// served by View Source.
import type { Request, Response } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import { curlFor, type CurlSpec } from '../../_shared/curl.js';
import { refusal, type Endpoint, type Intent } from '../../_shared/intents.js';
import type { Result } from '../../_shared/result.js';
import { CUSTOMER, allOrders, formatMoney, setLine, type CartTotals, type Order, type Product, type ShopState } from './shop.js';

export type { Result } from '../../_shared/result.js';
// The intent routing lives in districts/_shared/intents.ts (any district's labs use it, Q15); re-exported so every Relic
// Market lab and spec keeps importing it from here.
export { endpointsOf, mountIntents, refusal, success, UNKNOWN_ACTION } from '../../_shared/intents.js';
export type { Endpoint, Intent, Outcome, Render } from '../../_shared/intents.js';

/**
 * The cart's Remove button (plumbing, the same at every level): `POST <lab>/cart/remove` with `sku` (and
 * `kind=return` for a return line) removes that one line, so a mistaken line, a pending return included, can be taken
 * back even where the level refuses a quantity of 0. Removing a line only takes it out of the next checkout.
 */
export function removeLineIntent(stateOf: (req: Request) => ShopState): Intent {
  return {
    path: '/cart/remove', fields: ['sku', 'kind'],
    run: (req) => {
      const state = stateOf(req);
      const sku = field(req, 'sku');
      const kind = field(req, 'kind') === 'return' ? 'return' : undefined;
      const line = state.cart.find((l) => l.sku === sku && l.kind === kind);
      if (line === undefined) return refusal('That line is not in your cart.');
      return { result: setLine(state, { ...line, qty: 0 }) };
    },
  };
}

/**
 * The flag line for a fact that proves the flaw (an order, a balance, a result row): `Flag: …` below Divine, '' at
 * Divine, which never issues one. Call it only for a proving fact, and never inside tryDb.
 */
export function flagLine(req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>): string {
  return req.level === 'divine' ? '' : `Flag: ${flagFor(req, challenge)}`;
}

/** The message for someone signed in (RM-04's staff portal): only an admin holds the flag, and never at Divine. */
export function welcome(
  req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>,
  who: { readonly username: string; readonly role: string },
): Result {
  const hello = `Welcome, ${who.username} (role: ${who.role}).`;
  if (who.role !== 'admin' || req.level === 'divine') return { ok: true, text: hello };
  return { ok: true, text: `${hello} Flag: ${flagFor(req, challenge)}` };
}

/** An amount for a view: the cents (for data-cents hooks) and the formatted text. */
export interface Money { readonly cents: number; readonly text: string }
const money = (cents: number): Money => ({ cents, text: formatMoney(cents) });

// --- View data, in parts: the base every Relic Market page has, and the catalog, cart and orders of a shop ----------

/** What baseView needs: the parts of a page that every Relic Market lab has, shop or not. */
export interface BaseViewSpec {
  readonly result: Result | null;
  /** The page's curl line (src/districts/_shared/curl.ts); `signIn: false` for these labs, where nobody signs in. */
  readonly curl: CurlSpec;
  /** The intents' own doors (endpointsOf, or what mountIntents returned), for the one-line endpoint list. */
  readonly endpoints?: readonly Endpoint[];
  /**
   * The lab's GET endpoints for the API box, paths below the lab. A path with a parameter (`/api/orders/:id`) links to
   * its `example` (a concrete path, with its own query if it has one); without an example it is listed without a link.
   */
  readonly api?: readonly { readonly path: string; readonly description: string; readonly example?: string }[];
  /** The wallet (cents) the header shows; omit it and the header shows none. */
  readonly wallet?: number;
  /** The intent that ran (Outcome.intent); absent, the body's `intent` field is used. */
  readonly intent?: string;
  /** Lab-specific view data (never a reserved view key). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** What the player typed in the form that was posted: the intent that ran, and the `sku` and `qty` fields. */
const keptOf = (req: Request, intent: string | undefined) => ({ intent: intent ?? field(req, 'intent'), sku: field(req, 'sku'), qty: field(req, 'qty') });

/** An API entry's link: its example (or its path when that has no parameter) with the level; '' for a pattern with no example. */
function apiHref(base: string, level: string, e: { readonly path: string; readonly example?: string }): string {
  const target = e.example ?? e.path;
  if (e.example === undefined && /[:*]/.test(e.path)) return '';
  return `${base}${target}${target.includes('?') ? '&' : '?'}level=${level}`;
}

/**
 * The base of every Relic Market page, for views/shop-header, message, endpoints and api and the curl note: `base`
 * (labPath), `served` (the level; `level` is a reserved view key), the customer, the wallet or null, `result`, `kept`
 * (keptOf), `curl`, `endpoints` (with absolute hrefs), `api`, then the lab's `extra`.
 */
export function baseView(req: Request, res: Response, spec: BaseViewSpec): Record<string, unknown> {
  const base = labPath(res);
  const href = (path: string) => `${base}${path}?level=${req.level}`;
  return {
    base, served: req.level, customer: CUSTOMER, wallet: spec.wallet === undefined ? null : money(spec.wallet),
    result: spec.result, kept: keptOf(req, spec.intent),
    endpoints: (spec.endpoints ?? []).map((e) => ({ method: e.method, path: e.path, href: href(e.path), fields: e.fields })),
    api: (spec.api ?? []).map((e) => ({ method: 'GET', path: e.path, href: apiHref(base, req.level, e), description: e.description })),
    curl: curlFor(req, res, spec.curl),
    ...spec.extra,
  };
}

/**
 * The catalog part (views/catalog): one row per product with the level's hidden fields (`fields`, rendered verbatim)
 * and the quantity field, which keeps what the player typed only after an `add` of that product.
 */
export function catalogView(
  req: Request, state: ShopState,
  o: { readonly fields?: (p: Product) => Readonly<Record<string, string>>; readonly intent?: string } = {},
): { catalog: unknown[] } {
  const kept = keptOf(req, o.intent);
  return {
    catalog: state.catalog.products.map((p) => ({
      sku: p.sku, name: p.name, blurb: p.blurb, price: money(p.price),
      fields: Object.entries(o.fields?.(p) ?? {}), qty: kept.intent === 'add' && kept.sku === p.sku ? kept.qty : '1',
    })),
  };
}

/**
 * The cart part (views/cart): each line with the lab's line total (or its note), and the total (or its note).
 * `removable` adds a Remove button per line (for a lab that mounts removeLineIntent as `remove`). `checkoutIntent` is the
 * intent the Check out button posts (default `checkout`; a multi-step checkout such as RM-13 names its first step).
 */
export function cartView(
  state: ShopState, totals: CartTotals, o: { readonly removable?: boolean; readonly checkoutIntent?: string } = {},
): { cart: unknown } {
  const nameOf = (sku: string): string => state.catalog.get(sku)?.name ?? sku;
  return {
    cart: {
      removable: o.removable === true, checkoutIntent: o.checkoutIntent ?? 'checkout',
      rows: totals.lines.map(({ line, total }) => ({
        sku: line.sku, name: nameOf(line.sku), qty: line.qty, kind: line.kind ?? '', unit: money(line.unitPrice),
        line: typeof total === 'number' ? money(total) : null, note: typeof total === 'string' ? total : '',
      })),
      total: typeof totals.total === 'number' ? money(totals.total) : null,
      note: typeof totals.total === 'string' ? totals.total : '',
    },
  };
}

const isoTime = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '');

/**
 * The orders part (views/orders): the signed-in customer's own orders only (`owner === CUSTOMER.id`; seeded orders of
 * other customers are never listed here), pinned ones included, newest first, each order the lab's proof holds for with
 * its flag line (flagLine). An order id is a number or a string.
 */
export function ordersView(
  req: Pick<Request, 'sessionId' | 'level'>, state: ShopState,
  o: { readonly challenge: Pick<Challenge, 'id' | 'levels'>; readonly proves: (order: Order) => boolean },
): { orders: unknown[] } {
  return {
    orders: allOrders(state).filter((order) => order.owner === CUSTOMER.id).reverse().map((order) => ({
      no: order.no, status: order.status, at: isoTime(order.at),
      lines: order.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, kind: l.kind ?? '', unit: money(l.unitPrice) })),
      total: money(order.total), charged: money(order.charged),
      flag: o.proves(order) ? flagLine(req, o.challenge) : '',
    })),
  };
}

/** What shopView needs from a cart-and-checkout lab besides its state. */
export interface ShopViewSpec extends Omit<BaseViewSpec, 'wallet'> {
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  /** The cart as the lab computed it (exactTotals, or the level's own arithmetic). */
  readonly totals: CartTotals;
  /** The lab's proof (model.ts): each order it holds for gets the flag line below Divine. */
  readonly proves: (order: Order) => boolean;
  /** The level's hidden fields of a product's add-to-cart form, rendered verbatim (default none). */
  readonly fields?: (p: Product) => Readonly<Record<string, string>>;
  /** A Remove button per cart line (the lab mounts removeLineIntent as `remove`). */
  readonly removable?: boolean;
  /** The intent the cart's Check out button posts (default `checkout`). */
  readonly checkoutIntent?: string;
}

/**
 * The whole view data of a cart-and-checkout page: baseView (with the shop's wallet), catalogView, cartView and
 * ordersView, then the lab's `extra`. A lab without a cart (store credit, an exchange, an API) uses baseView and the
 * parts it has.
 */
export function shopView(req: Request, res: Response, state: ShopState, spec: ShopViewSpec): Record<string, unknown> {
  const { extra, ...base } = spec;
  return {
    ...baseView(req, res, { ...base, wallet: state.wallet }),
    ...catalogView(req, state, { fields: spec.fields, intent: spec.intent }),
    ...cartView(state, spec.totals, { removable: spec.removable, checkoutIntent: spec.checkoutIntent }),
    ...ordersView(req, state, { challenge: spec.challenge, proves: spec.proves }),
    ...extra,
  };
}
