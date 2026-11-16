// model.ts — RM-06's shop, per-player state, the promotions, the discount math, the contract every levels/<level>.ts
// implements and the proof. Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import type { Result } from '../../_shared/result.js';
import { LIMITS, catalogOf, exactValue, newShop, perShop, type Order, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $70.00. */
export const START_WALLET = 7000;

export const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary of the First Pilgrim', price: 10000, blurb: 'Gilded silver, said to hold a sandal strap of the first pilgrim to reach the citadel.' },
  { sku: 'ICON', name: 'Painted Icon', price: 3500, blurb: 'Egg tempera on lime wood, framed in cedar.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** A promotion: a percentage of the running total, or a fixed amount that needs a minimum running total. */
export type Coupon =
  | { readonly kind: 'percent'; readonly pct: number; readonly blurb: string }
  | { readonly kind: 'fixed'; readonly amount: number; readonly min: number; readonly blurb: string };

/** The promotions (a Map: `constructor` is no code). */
export const COUPONS: ReadonlyMap<string, Coupon> = new Map<string, Coupon>([
  ['WELCOME10', { kind: 'percent', pct: 10, blurb: '10% off' }],
  ['SPRING15', { kind: 'percent', pct: 15, blurb: '15% off' }],
  ['RELIC20', { kind: 'fixed', amount: 2000, min: 8000, blurb: '$20.00 off when the running total is at least $80.00' }],
]);

/**
 * What one promotion takes off a running total (integer cents): a percentage takes floor(running x pct / 100), a fixed
 * amount takes min(amount, running) while the running total is at least its minimum, else nothing.
 */
function discountOf(c: Coupon, running: number): number {
  if (c.kind === 'percent') return Math.floor(running * c.pct / 100);
  return running >= c.min ? Math.min(c.amount, running) : 0;
}

/** One applied promotion and what it took off. */
export interface Step { readonly code: string; readonly amount: number }

/**
 * Walk the applied codes in order over a list subtotal: each takes its discount off the running total. The total is
 * what remains, never below 0. This is the model at every level; which codes get applied is the level's decision.
 */
export function walk(subtotal: number, codes: readonly string[]): { readonly steps: readonly Step[]; readonly total: number } {
  let running = subtotal;
  const steps: Step[] = [];
  for (const code of codes) {
    const c = COUPONS.get(code);
    const amount = c === undefined ? 0 : discountOf(c, running);
    steps.push({ code, amount });
    running -= amount;
  }
  return { steps, total: running };
}

/** The largest discount any ONE promotion gives alone on a list subtotal: what the one-per-order rule allows. */
export function bestSingle(subtotal: number): number {
  return Math.max(0, ...[...COUPONS.values()].map((c) => discountOf(c, subtotal)));
}

/** One player's shop at one level: the promotions applied to the cart, by code, in the order applied. */
export interface LabState extends ShopState {
  readonly coupons: string[];
}

const labs = perShop((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: START_WALLET }), coupons: [] }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/**
 * Append a known code to the cart (levels call this once they decided to). Platform bound, not the lesson: at most
 * LIMITS.discounts promotions on a cart.
 */
export function addCoupon(state: LabState, code: string): Result {
  if (state.coupons.length >= LIMITS.discounts) return { ok: false, text: `Too many promotions on this cart (${LIMITS.discounts}).` };
  state.coupons.push(code); // `code` is a COUPONS key: a constant, never the player's string
  return { ok: true, text: `Promotion ${code} applied.` };
}

/** A request body's field as the parser left it: a string, an array (repeated or `code[]` fields, JSON), an object... */
export function rawField(body: unknown, name: string): unknown {
  if (body === null || typeof body !== 'object' || !Object.hasOwn(body, name)) return undefined;
  const value: unknown = Reflect.get(body, name);
  return value;
}

/** What every levels/<level>.ts exports (checked by byLevel<CouponLevel> in challenge.ts). */
export interface CouponLevel {
  /** The promotion form's request body (parsed form or JSON, whatever shape): apply code(s), or say why not. */
  applyCoupon(state: LabState, body: unknown): Result;
}

/** The cart's list subtotal (qty x list price, exact: quantities are 1 to 99). */
export function listSubtotal(state: LabState): number {
  return state.cart.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
}

/**
 * The proof (the oracle, not the flaw): a paid order whose discount is bigger than ANY single promotion gives on its
 * LIST subtotal. It reads the order's list prices, never the discounted lines or the current catalog.
 */
export function proves(order: Order): boolean {
  const list = Number(exactValue(order.lines));
  return order.status === 'paid' && list - order.charged > bestSingle(list);
}
