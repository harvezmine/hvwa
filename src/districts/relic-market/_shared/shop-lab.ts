// src/districts/relic-market/_shared/shop-lab.ts — the Express side of the Relic Market shop labs: intent dispatch, the
// shared view data and the flag lines. Plumbing only: a lab's routes call its levels/*.ts for every decision (how a
// request becomes a line, what a checkout may charge) and its model.ts for the proof. Not a challenge: nothing here is
// served by View Source.
import type { Request, Response, Router } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import { curlFor, type CurlSpec } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';
import { CUSTOMER, formatMoney, type CartTotals, type Order, type Product, type ShopState } from './shop.js';

export type { Result } from '../../_shared/result.js';

/**
 * What an intent came to: the message to show and, optionally, the response status. mountIntents adds `intent`, the
 * name of the intent that ran (undefined for an unknown action), before it calls render.
 */
export interface Outcome { readonly result: Result | null; readonly status?: number; readonly intent?: string }

/** One action of a shop page: a hidden `intent` on `POST /`, and its own path (`POST <lab><path>`) for curl. */
export interface Intent {
  readonly path: string;
  /** The body fields it reads, for the page's endpoint list (documentation only). */
  readonly fields?: readonly string[];
  readonly run: (req: Request, res: Response) => Outcome | Promise<Outcome>;
}

/** An intent's own door, as the page's endpoint list shows it. */
export interface Endpoint { readonly method: 'POST'; readonly path: string; readonly intent: string; readonly fields: readonly string[] }

/** The doors of an intent table, in its order. */
export function endpointsOf(intents: Readonly<Record<string, Intent>>): Endpoint[] {
  return Object.entries(intents).map(([intent, i]) => ({ method: 'POST', path: i.path, intent, fields: [...(i.fields ?? [])] }));
}

/** Paths an intent may not take: POST / dispatches, and the engine mounts Restart and the victim's actions. */
const isReserved = (path: string): boolean => path === '/' || path === '/_reset' || path === '/victim' || path.startsWith('/victim/');

/** Renders the lab page after an intent ran. */
export type Render = (req: Request, res: Response, outcome: Outcome) => Promise<void>;

/** The answer to a missing or unknown intent (200, never a 500). */
export const UNKNOWN_ACTION: Result = Object.freeze({ ok: false, text: 'Unknown action.' });

/** An intent's refusal. */
export const refusal = (text: string): Outcome => ({ result: { ok: false, text } });
/** An intent's success. */
export const success = (text: string): Outcome => ({ result: { ok: true, text } });

/**
 * Mount a shop page's actions: `POST /` dispatches on the body's `intent` field (the page's forms post back with no
 * action and a hidden intent), and each intent is also mounted on its own path. Then `render` draws the page with the
 * outcome and the intent's name. A missing, unknown or non-string intent answers 200 with UNKNOWN_ACTION. Throws at
 * mount time on a path that is relative, repeated, `/`, or one of the engine's (`/_reset`, `/victim/...`). Returns the
 * table's endpoints (endpointsOf).
 */
export function mountIntents(router: Router, intents: Readonly<Record<string, Intent>>, render: Render): Endpoint[] {
  const table = new Map(Object.entries(intents)); // a Map: `constructor` or `__proto__` is no intent
  const paths = new Set<string>();
  for (const [name, i] of table) {
    if (!i.path.startsWith('/') || isReserved(i.path)) throw new Error(`mountIntents: intent "${name}" may not use the path "${i.path}"`);
    if (paths.has(i.path)) throw new Error(`mountIntents: two intents use the path "${i.path}"`);
    paths.add(i.path);
  }
  const answer = async (req: Request, res: Response, name: string | undefined): Promise<void> => {
    const intent = name === undefined ? undefined : table.get(name);
    const outcome: Outcome = intent === undefined ? { result: UNKNOWN_ACTION } : await intent.run(req, res);
    if (outcome.status !== undefined) res.status(outcome.status);
    await render(req, res, { ...outcome, intent: intent === undefined ? undefined : name });
  };
  router.post('/', async (req, res) => { await answer(req, res, field(req, 'intent')); });
  for (const [name, intent] of table) {
    router.post(intent.path, async (req, res) => { await answer(req, res, name); });
  }
  return endpointsOf(intents);
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
  /** The lab's GET endpoints for the API box, paths below the lab. */
  readonly api?: readonly { readonly path: string; readonly description: string }[];
  /** The wallet (cents) the header shows; omit it and the header shows none. */
  readonly wallet?: number;
  /** The intent that ran (Outcome.intent); absent, the body's `intent` field is used. */
  readonly intent?: string;
  /** Lab-specific view data (never a reserved view key). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** What the player typed in the form that was posted: the intent that ran, and the `sku` and `qty` fields. */
const keptOf = (req: Request, intent: string | undefined) => ({ intent: intent ?? field(req, 'intent'), sku: field(req, 'sku'), qty: field(req, 'qty') });

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
    api: (spec.api ?? []).map((e) => ({ method: 'GET', path: e.path, href: href(e.path), description: e.description })),
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

/** The cart part (views/cart): each line with the lab's line total (or its note), and the total (or its note). */
export function cartView(state: ShopState, totals: CartTotals): { cart: unknown } {
  const nameOf = (sku: string): string => state.catalog.get(sku)?.name ?? sku;
  return {
    cart: {
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

/** The orders part (views/orders): newest first, each order the lab's proof holds for with its flag line (flagLine). */
export function ordersView(
  req: Pick<Request, 'sessionId' | 'level'>, state: ShopState,
  o: { readonly challenge: Pick<Challenge, 'id' | 'levels'>; readonly proves: (order: Order) => boolean },
): { orders: unknown[] } {
  return {
    orders: [...state.orders].reverse().map((order) => ({
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
    ...cartView(state, spec.totals),
    ...ordersView(req, state, { challenge: spec.challenge, proves: spec.proves }),
    ...extra,
  };
}
