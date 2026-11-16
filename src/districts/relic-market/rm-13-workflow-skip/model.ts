// model.ts — RM-13's shop, checkout flows, the simulated payment provider ("Pilgrim Pay"), per-player state, the contract
// every levels/<level>.ts implements and the proof. Not served: View Source shows only levels/*.ts, and nothing here has
// a route. The levels import values from here (this file never imports a level, so there is no cycle).
import { createHmac, randomBytes } from 'node:crypto';
import type { Level } from '../../../core/levels.js';
import { newId } from '../../_shared/collections.js';
import type { Result } from '../../_shared/result.js';
import { catalogOf, newShop, perShop, type Order, type OrderLine, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $5.00. */
export const START_WALLET = 500;

export const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary', price: 20000, blurb: 'A crystal reliquary on a gilded stand, sealed by the abbey.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** Where a checkout is: start, shipping, pay, confirm. */
export type FlowState = 'created' | 'shipping' | 'paid' | 'confirmed';

/** One checkout of one player: the cart as it was when it started, and how far the flow got. */
export interface CheckoutFlow {
  readonly id: string;
  readonly lines: readonly OrderLine[];
  readonly total: number;
  state: FlowState;
  /** What the shop's own records say it has been paid (0 until a level marks the checkout paid). */
  paid: number;
  /** What Pilgrim Pay actually took from the wallet (its ledger, written only by pspCharge): the truth the proof is measured against. */
  received: number;
  /** The server knows the provider declined the last payment (set by the level that records it; shown on the return page). */
  declined: boolean;
  address: string;
  /** The order number once confirmed. */
  orderNo?: number;
}

/** One player's shop at one level: the shop, its open checkouts and the payment provider's signing key. */
export interface LabState extends ShopState {
  /** Oldest first, at most MAX_CHECKOUTS (platform safety). */
  readonly checkouts: CheckoutFlow[];
  /** Pilgrim Pay's signing key (32 random bytes per instance): Divine verifies the provider's notify with it. */
  readonly pspKey: Buffer;
}

/** Most checkouts a player keeps open: platform safety (the oldest are dropped). */
export const MAX_CHECKOUTS = 10;

const labs = perShop((): LabState => ({
  ...newShop({ catalog: CATALOG, wallet: START_WALLET }),
  checkouts: [],
  pspKey: randomBytes(32),
}));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Test seam: the payment provider's key of session `sessionId` at `level` (what Divine verifies a notify with). */
export const pspKey = (sessionId: string, level: Level): Buffer => labs.for({ sessionId, level }).pspKey;
/** Restart lab: drop this (session, level)'s shop, checkouts and key. No limiter or budget lives here, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** A new checkout id: 8 random hex characters. */
export const newCheckoutId = (): string => newId().slice(0, 8);

/** The checkout with this id (ids are compared, never used as object keys), or undefined. */
export function findCheckout(state: LabState, id: string): CheckoutFlow | undefined {
  return state.checkouts.find((c) => c.id === id);
}

/** Add a checkout, dropping the oldest beyond MAX_CHECKOUTS (platform safety). */
export function addCheckout(state: LabState, co: CheckoutFlow): void {
  state.checkouts.push(co);
  while (state.checkouts.length > MAX_CHECKOUTS) state.checkouts.shift();
}

// --- Pilgrim Pay: the simulated payment provider --------------------------------------------------------------------

/**
 * "Pilgrim Pay" takes the checkout's total: debits the wallet when it covers it, records it in the provider's own ledger
 * (`received`) and says whether it did. In-process, no network. Whether the SHOP then believes it was paid is the
 * level's decision (`paid`), and the proof compares the two.
 */
export function pspCharge(state: ShopState, co: CheckoutFlow): boolean {
  if (!Number.isSafeInteger(co.total) || co.total < 0 || state.wallet < co.total) return false;
  state.wallet -= co.total;
  co.received += co.total;
  return true;
}

/** What the provider tells the shop server-to-server after a payment. */
export interface PspNotify {
  readonly checkout: string;
  readonly amount: number;
  readonly status: 'success' | 'failed';
}

/** The provider's signature of a notify: HMAC-SHA256 over `checkout|amount|status` under the instance's key, as hex. */
export function signNotify(key: Buffer, m: PspNotify): string {
  return createHmac('sha256', key).update(`${m.checkout}|${m.amount}|${m.status}`).digest('hex');
}

// --- The contract ---------------------------------------------------------------------------------------------------

/** The cookie a level may keep its payment step in: named after the level, so a level reads only its own. */
export const stepCookie = (level: Level): string => `relic_step_${level}`;

/** What a level's pay step came to. */
export type PayOutcome =
  /** The payment is settled right here: the message, and (Templar) a cookie the browser keeps. */
  | {
    readonly kind: 'settled'; readonly result: Result;
    /** The status of a refusal (default 402). */
    readonly status?: number;
    readonly cookie?: { readonly name: string; readonly value: string };
  }
  /** The browser goes on to the lab's return page (303) with the provider's answer. */
  | { readonly kind: 'redirect'; readonly status: 'success' | 'failed' };

/** What every levels/<level>.ts exports (checked by byLevel<FlowLevel> in challenge.ts). */
export interface FlowLevel {
  /** Pay the checkout (the route has already refused a checkout that is paid or confirmed). */
  pay(state: LabState, co: CheckoutFlow): PayOutcome;
  /** The browser arrived at the return page with `status` (the raw query value): what the server does with it. */
  paymentReturn(state: LabState, co: CheckoutFlow, status: string): Result;
  /** Confirm the order: `ok` only when the level lets the checkout through (and then the checkout is `confirmed`). */
  confirm(state: LabState, co: CheckoutFlow, req: { readonly stepCookie: string | undefined }): Result;
}

/** What a checkout says about itself (the return page of levels that only display state). */
export function describeFlow(co: CheckoutFlow): string {
  switch (co.state) {
    case 'paid': return 'Payment received.';
    case 'confirmed': return 'Payment received and the order is confirmed.';
    default: return co.declined ? 'Payment failed: the provider declined it.' : 'Payment not received yet.';
  }
}

/** The proof (the oracle, not the flaw): an order confirmed for shipping with less actually charged (the provider's ledger) than it is worth. */
export function proves(order: Order): boolean {
  return order.status === 'confirmed' && order.charged < order.total;
}
