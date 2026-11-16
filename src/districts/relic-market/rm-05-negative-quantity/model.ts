// model.ts — RM-05's shop, per-player state, the contract every levels/<level>.ts implements and the proof.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { catalogOf, newShop, type Order, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $50.00. */
export const START_WALLET = 5000;

export const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary of the First Pilgrim', price: 100000, blurb: 'Gilded silver, said to hold a sandal strap of the first pilgrim to reach the citadel.' },
  { sku: 'ROSARY', name: "Pilgrim's Rosary", price: 4000, blurb: 'Olive-wood beads on waxed cord, blessed at the east gate.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** One player's shop at one level. `owned` and `returned` are keyed by catalog SKUs only (the routes check them). */
export interface LabState extends ShopState {
  /** Units bought, per SKU (every paid purchase line). */
  readonly owned: Map<string, number>;
  /** Units returned for store credit, per SKU (every paid return line). */
  readonly returned: Map<string, number>;
}

const labs = perSession((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: START_WALLET }), owned: new Map(), returned: new Map() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** What every levels/<level>.ts exports (checked by byLevel<QtyLevel> in challenge.ts). */
export interface QtyLevel {
  /** The quantity typed into an add-to-cart or return form, or why it is refused. */
  parseQty(raw: string): number | string;
  /** Whether `n` units of `sku` may be returned for store credit now, or why not. */
  returnable(state: LabState, sku: string, n: number): true | string;
  /** Whether a cart that totals `total` cents may be paid from `wallet`, or why not. */
  checkoutAllowed(total: number, wallet: number): true | string;
}

/**
 * The proof (the oracle, not the flaw): a paid order with at least one Reliquary bought. With a $50.00 wallet and a
 * $1,000.00 reliquary that is impossible without the flaw. It reads the order, never the current catalog.
 */
export function proves(order: Order): boolean {
  return order.status === 'paid' && order.lines.some((l) => l.sku === 'RELIQUARY' && l.kind !== 'return' && l.qty >= 1);
}
