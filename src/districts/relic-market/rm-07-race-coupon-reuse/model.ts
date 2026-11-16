// model.ts — RM-07's shop, per-player state, the voucher, the contract every levels/<level>.ts implements and the proof.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import type { Result } from '../../_shared/result.js';
import { catalogOf, newShop, perShop, type Order, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $25.00. */
export const START_WALLET = 2500;

export const CATALOG = catalogOf([
  { sku: 'LANTERN', name: 'Pilgrim\'s Lantern', price: 5000, blurb: 'Hammered brass with a horn pane; the wick is trimmed for you.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** The voucher: $15.00 off a subtotal of at least $20.00, single use per account. */
export const VOUCHER = Object.freeze({ code: 'FIRSTRELIC', amount: 1500, min: 2000 });

/** One player's shop at one level: the single-use voucher's state and the guard of the double-submit level. */
export interface LabState extends ShopState {
  /** Whether this account has used (or, at Divine, reserved) the voucher. */
  voucherUsed: boolean;
  /** The raw inputs being applied right now (Inquisitor's double-submit guard; its level keeps it at 10 or fewer). */
  readonly inFlight: Set<string>;
}

const labs = perShop((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: START_WALLET }), voucherUsed: false, inFlight: new Set() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** The cart's list subtotal (qty x list price, exact: quantities are 1 to 99). */
export function listSubtotal(state: LabState): number {
  return state.cart.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
}

/** What every levels/<level>.ts exports (checked by byLevel<VoucherLevel> in challenge.ts). */
export interface VoucherLevel {
  /**
   * Apply the voucher typed into the form, or say why not. Async because it waits for the promotions service; the
   * route calls it right after `state.gate.arrive()` and before any await, so arrival and the check share one
   * synchronous segment.
   */
  applyVoucher(state: LabState, raw: string): Promise<Result>;
}

/**
 * The proof (the oracle, not the flaw): a paid order with at least two FIRSTRELIC discounts. Two bring the order to
 * $20.00, which the $25.00 wallet covers; one leaves $35.00, which it does not.
 */
export function proves(order: Order): boolean {
  return order.status === 'paid' && order.discounts.filter((d) => d.code === VOUCHER.code).length >= 2;
}
