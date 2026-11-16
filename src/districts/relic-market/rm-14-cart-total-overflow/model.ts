// model.ts — RM-14's shop, per-player state, the contract every levels/<level>.ts implements and the proof.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import { catalogOf, exactValue, newShop, perShop, type Order, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $50.00. */
export const START_WALLET = 5000;

export const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary', price: 999_900, blurb: 'Rock crystal and gold, with the abbey\'s seal.' },
  { sku: 'ALTAR', name: 'Golden Altar', price: 19_999_999, blurb: 'A gilded travelling altar, delivered by ox cart.' },
  { sku: 'THRONE', name: 'Jeweled Throne', price: 14_999_999, blurb: 'Carved oak under garnets and pearls.' },
  { sku: 'CHALICE', name: 'Silver Chalice', price: 125_000, blurb: 'Hand-chased silver.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
  { sku: 'SLIP', name: 'Prayer Slip', price: 1, blurb: 'One cent buys one prayer, written by the brothers.' },
]);

/** One player's shop at one level: the shell's state, nothing more. */
export type LabState = ShopState;

const labs = perShop((): LabState => newShop({ catalog: CATALOG, wallet: START_WALLET }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** What every levels/<level>.ts exports (checked by byLevel<IntLevel> in challenge.ts). */
export interface IntLevel {
  /** The quantity typed into an add-to-cart form, or why it is refused. */
  parseQty(raw: string): number | string;
  /** A line's total in cents (price x qty, as this level computes it), or why the line is refused. */
  lineTotal(price: number, qty: number): number | string;
  /** The running cart total after adding one line's total, as this level computes it. */
  addToTotal(total: number, line: number): number;
  /** Whether a cart that totals `total` cents may be paid from `wallet`, or why not. */
  checkoutAllowed(total: number, wallet: number): true | string;
}

/**
 * The proof (the oracle, not the flaw): a paid order with a Reliquary in it, charged less than its lines are really
 * worth. exactValue is BigInt: at Templar the true sum is beyond 2^32, and it can pass 2^53.
 */
export function proves(order: Order): boolean {
  return order.status === 'paid'
    && order.lines.some((l) => l.sku === 'RELIQUARY' && l.qty >= 1)
    && BigInt(order.charged) < exactValue(order.lines);
}
