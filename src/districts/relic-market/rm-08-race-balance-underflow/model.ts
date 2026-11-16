// model.ts — RM-08's store credit, per-player state, what a spend records, the contract every levels/<level>.ts
// implements and the proof. Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import type { Result } from '../../_shared/result.js';
import { CUSTOMER, catalogOf, newShop, perShop, pushOrder, type ShopState } from '../_shared/shop.js';

/** The store credit every instance starts with: $20.00. The wallet of the shell is this lab's store credit. */
export const START_WALLET = 2000;

/** What each of the two ways to spend costs: $15.00. */
export const SPEND = 1500;

export const CATALOG = catalogOf([
  { sku: 'LANTERN', name: 'Pilgrim\'s Lantern', price: SPEND, blurb: 'Hammered brass with a horn pane; the wick is trimmed for you.' },
]);

/** A gift card sent from the store credit. */
export interface Gift { readonly to: string }

/** Platform safety: the gift list keeps the newest 10. */
export const MAX_GIFTS = 10;

/** One player's shop at one level: its store credit (`wallet`) and the gift cards sent from it. */
export interface LabState extends ShopState {
  /** Oldest first, at most MAX_GIFTS. */
  readonly gifts: Gift[];
}

const labs = perShop((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: START_WALLET }), gifts: [] }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** Platform safety: the credit stays a safe integer, whatever the levels did to it. */
function assertSafe(state: LabState): void {
  if (!Number.isSafeInteger(state.wallet)) throw new Error('RM-08: the store credit left the safe integers');
}

/**
 * Book a purchase after the level took the credit: one paid order for one lantern (the purchase history), numbered by
 * the shop. It never touches the credit: whether and when it is taken is the level's decision.
 */
export function recordPurchase(state: LabState): Result {
  assertSafe(state);
  const lantern = CATALOG.products[0];
  pushOrder(state, Object.freeze({
    no: state.nextOrderNo, owner: CUSTOMER.id,
    lines: Object.freeze([Object.freeze({ sku: lantern.sku, name: lantern.name, qty: 1, unitPrice: lantern.price, listPrice: lantern.price })]),
    discounts: Object.freeze([]), subtotal: SPEND, total: SPEND, charged: SPEND, status: 'paid', at: state.clock.now(),
  }));
  state.nextOrderNo += 1;
  return { ok: true, text: `${lantern.name} bought.` };
}

/** Book a gift card after the level took the credit. `to` is already clipped by the route (clipText). */
export function recordGift(state: LabState, to: string): Result {
  assertSafe(state);
  state.gifts.push(Object.freeze({ to }));
  while (state.gifts.length > MAX_GIFTS) state.gifts.shift();
  return { ok: true, text: `Gift card sent to ${to}.` };
}

/** What every levels/<level>.ts exports (checked by byLevel<UnderflowLevel> in challenge.ts). */
export interface UnderflowLevel {
  /**
   * Buy the lantern with store credit, or say why not. Async because the ledger takes time; the route calls it right
   * after `state.gate.arrive()` and before any await.
   */
  buy(state: LabState): Promise<Result>;
  /** Send a gift card (the route checked and clipped the recipient) with store credit, or say why not. */
  gift(state: LabState, to: string): Promise<Result>;
}

/** The proof (the oracle, not the flaw): the store credit is below zero, which spending only what you have never does. */
export function proves(state: LabState): boolean {
  return state.wallet < 0;
}
