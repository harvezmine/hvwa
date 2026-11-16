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

/** What shopView needs from a lab besides its state. */
export interface ShopViewSpec {
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  readonly result: Result | null;
  /** The cart as the lab computed it (exactTotals, or the level's own arithmetic). */
  readonly totals: CartTotals;
  /** The lab's proof (model.ts): each order it holds for gets the flag line below Divine. */
  readonly proves: (order: Order) => boolean;
  /** The page's curl line (src/districts/_shared/curl.ts). */
  readonly curl: CurlSpec;
  /** The level's hidden fields of a product's add-to-cart form, rendered verbatim (default none). */
  readonly fields?: (p: Product) => Readonly<Record<string, string>>;
  /** The lab's GET endpoints for the API box, paths below the lab. */
  readonly api?: readonly { readonly path: string; readonly description: string }[];
  /** Lab-specific view data (never a reserved view key). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

const isoTime = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '');

/**
 * The shared view data of a shop page, for the partials in views/: `base` (labPath), `served` (the level; `level` is a
 * reserved view key), the customer, the wallet, catalog rows (with the level's hidden fields and the quantity the player
 * typed kept in that product's field), the cart with the lab's line totals and total, the orders newest first (each
 * proving one with its flag line), `kept`, the API box, the curl line, `result`, and the lab's `extra`.
 */
export function shopView(req: Request, res: Response, state: ShopState, spec: ShopViewSpec): Record<string, unknown> {
  const base = labPath(res);
  const kept = { sku: field(req, 'sku'), qty: field(req, 'qty') };
  const { totals } = spec;
  const nameOf = (sku: string): string => state.catalog.get(sku)?.name ?? sku;
  return {
    base, served: req.level, customer: CUSTOMER, wallet: money(state.wallet), result: spec.result, kept,
    catalog: state.catalog.products.map((p) => ({
      sku: p.sku, name: p.name, blurb: p.blurb, price: money(p.price),
      fields: Object.entries(spec.fields?.(p) ?? {}), qty: kept.sku === p.sku ? kept.qty : '1',
    })),
    cart: {
      rows: totals.lines.map(({ line, total }) => ({
        sku: line.sku, name: nameOf(line.sku), qty: line.qty, kind: line.kind ?? '', unit: money(line.unitPrice),
        line: typeof total === 'number' ? money(total) : null, note: typeof total === 'string' ? total : '',
      })),
      total: typeof totals.total === 'number' ? money(totals.total) : null,
      note: typeof totals.total === 'string' ? totals.total : '',
    },
    orders: [...state.orders].reverse().map((o) => ({
      no: o.no, status: o.status, at: isoTime(o.at),
      lines: o.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, kind: l.kind ?? '', unit: money(l.unitPrice) })),
      total: money(o.total), charged: money(o.charged),
      flag: spec.proves(o) ? flagLine(req, spec.challenge) : '',
    })),
    api: (spec.api ?? []).map((e) => ({ method: 'GET', path: e.path, href: `${base}${e.path}?level=${req.level}`, description: e.description })),
    curl: curlFor(req, res, spec.curl),
    ...spec.extra,
  };
}
