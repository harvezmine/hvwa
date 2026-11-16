// model.ts — RM-09's shop, price lists, per-player state, the contract every levels/<level>.ts implements and the
// proof. Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import { CUSTOMER, catalogOf, newShop, perShop, type Order, type Product, type ShopState } from '../_shared/shop.js';

/** The wallet every instance starts with: $25.00. */
export const START_WALLET = 2500;

export const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary', price: 50000, blurb: 'A crystal reliquary on a gilded stand, sealed by the abbey.' },
  { sku: 'CHALICE', name: 'Silver Chalice', price: 4000, blurb: 'Hand-chased silver, a gift shop favourite.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** A price list: a percentage of the retail (catalog) price. Public at every level (GET <lab>/api/price-lists). */
export interface PriceList { readonly name: string; readonly percent: number; readonly description: string }

export const PRICE_LISTS: readonly PriceList[] = Object.freeze([
  Object.freeze({ name: 'retail', percent: 100, description: 'everyone' }),
  Object.freeze({ name: 'partner', percent: 60, description: 'registered resellers' }),
  Object.freeze({ name: 'staff', percent: 1, description: 'staff samples, employees only' }),
]);

/** The price list called `name`, or undefined (a lookup by value, never an object index). */
export function priceList(name: string): PriceList | undefined {
  return PRICE_LISTS.find((l) => l.name === name);
}

/** A product's price on a list, in cents: floor(retail x percent / 100). */
export function listPrice(p: Product, list: PriceList): number {
  return Math.floor((p.price * list.percent) / 100);
}

/** The signed-in customer's account, kept server-side in the session: pilgrim is on the retail list. */
export interface Account { readonly customer: string; readonly priceList: string }

/** One player's shop at one level. */
export interface LabState extends ShopState { readonly account: Account }

const labs = perShop((): LabState => ({
  ...newShop({ catalog: CATALOG, wallet: START_WALLET }),
  account: Object.freeze({ customer: CUSTOMER.id, priceList: 'retail' }),
}));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

/** The request an add-to-cart form sent (levels read its fields with field()). */
export interface Form { readonly body?: unknown }

/** What every levels/<level>.ts exports (checked by byLevel<PriceLevel> in challenge.ts). */
export interface PriceLevel {
  /** The hidden fields this level puts in a product's add-to-cart form. */
  formFields(p: Product): Readonly<Record<string, string>>;
  /** The unit price (cents) the cart line stores for `p`, or why the request is refused. */
  unitPrice(p: Product, form: Form, account: Account): number | string;
}

/** Quantities are not this lab's lesson: 1 to 99 at every level (plumbing). */
export function parseQty(raw: string): number | string {
  const n = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
  return n >= 1 ? n : 'Quantity must be a whole number from 1 to 99.';
}

/**
 * The proof (the oracle, not the flaw): a paid order with a line charged below its retail list price. The order
 * keeps both prices per line, so the proof never reads the current catalog.
 */
export function proves(order: Order): boolean {
  return order.status === 'paid' && order.lines.some((l) => l.kind !== 'return' && l.unitPrice < l.listPrice);
}
