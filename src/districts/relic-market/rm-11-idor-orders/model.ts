// model.ts — RM-11's customers, seeded orders, per-player state, the contract every levels/<level>.ts implements and the
// proof. Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import type { Level } from '../../../core/levels.js';
import { CUSTOMER, catalogOf, newShop, perShop, pinOrder, type Order, type OrderLine, type ShopState } from '../_shared/shop.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

export const CATALOG = catalogOf([
  { sku: 'CHALICE', name: 'Silver Chalice', price: 4000, blurb: 'Hand-chased silver.' },
  { sku: 'ROSARY', name: 'Pilgrim\'s Rosary', price: 4000, blurb: 'Olive-wood beads.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Beeswax, burns for about six hours.' },
]);

/** The customers of the market: the shopper is CUSTOMER (`pilgrim`); the other two are the people whose orders are not yours. */
export const CUSTOMERS: Readonly<Record<string, string>> = Object.freeze({
  'C-1042': 'pilgrim', 'C-1043': 'Sister Maren', 'C-1044': 'Brother Tobias',
});

/** A seeded order: the shop's Order (with a string id) plus where it ships and its gift message. */
export interface PlacedOrder extends Order {
  readonly no: string;
  readonly city: string;
  readonly gift: string;
}

/** How an order id looks at a level. */
export type IdStyle = 'number' | 'base64url' | 'random';

/** Which door asks: the page (an order page, the Find form) or the JSON API. */
export type Channel = 'page' | 'api';

/** What every levels/<level>.ts exports (checked by byLevel<OrdersLevel> in challenge.ts). */
export interface OrdersLevel {
  /** How order ids look: sequential numbers, base64url-encoded numbers or random ids. */
  readonly idStyle: IdStyle;
  /** Whether the "recently shipped" feed prints the order ids. */
  readonly feedShowsIds: boolean;
  /** Whether a refusal is the same answer as a missing order. */
  readonly uniformNotFound: boolean;
  /** May the viewer read this one order through this door? */
  canRead(viewerId: string, order: PlacedOrder, channel: Channel): boolean;
  /**
   * The batch door: one slot per requested id (an unknown id is undefined; an id asked twice is asked once). The
   * orders to serve, or 'deny' for the whole request.
   */
  authorizeBatch(viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny';
}

/** The ids of the four seeded orders (yours, Sister Maren's the target, Brother Tobias's). */
export interface SeededIds { readonly own: readonly [string, string]; readonly victim: string; readonly tobias: string }

/** One player's lab at one level: a shop whose pinned store holds the seeded orders (in seeding order). */
export interface LabState extends ShopState {
  readonly records: readonly PlacedOrder[];
  readonly ids: SeededIds;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `ORD-` and ten Crockford base32 characters from the CSPRNG (50 bits, drawn per player). */
function randomOrderId(): string {
  return `ORD-${Array.from(randomBytes(10), (b) => CROCKFORD.charAt(b & 31)).join('')}`;
}

const STYLE: Readonly<Record<Level, IdStyle>> = {
  acolyte: acolyte.idStyle, templar: templar.idStyle, inquisitor: inquisitor.idStyle, divine: divine.idStyle,
};

function idOf(style: IdStyle, n: number): string {
  if (style === 'number') return String(n);
  if (style === 'base64url') return Buffer.from(String(n)).toString('base64url');
  return randomOrderId();
}

export const VICTIM_GIFT = 'For Brother Anselm: the vault seal rests under the third lantern.';

const lineOf = (sku: string, qty: number): OrderLine => {
  const p = CATALOG.get(sku);
  if (p === undefined) throw new Error(`RM-11: the catalog has no ${sku}`);
  return Object.freeze({ sku, name: p.name, qty, unitPrice: p.price, listPrice: p.price });
};

const labs = perShop((level): LabState => {
  const state = newShop({ catalog: CATALOG, wallet: 0 });
  const style = STYLE[level];
  const seed = (n: number, owner: string, sku: string, qty: number, city: string, gift: string, day: number): PlacedOrder => {
    const line = lineOf(sku, qty);
    const total = line.unitPrice * qty;
    const order: PlacedOrder = Object.freeze({
      no: idOf(style, n), owner, lines: Object.freeze([line]), discounts: Object.freeze([]), subtotal: total, total,
      charged: total, status: 'shipped', at: Date.UTC(2026, 9, day), city, gift,
    });
    pinOrder(state, order);
    return order;
  };
  const o1001 = seed(1001, CUSTOMER.id, 'CANDLE', 3, 'Jakarta', 'Light one for the road.', 3);
  const o1002 = seed(1002, 'C-1043', 'CHALICE', 1, 'Bandung', VICTIM_GIFT, 4);
  const o1003 = seed(1003, CUSTOMER.id, 'ROSARY', 1, 'Jakarta', '', 5);
  const o1004 = seed(1004, 'C-1044', 'ROSARY', 2, 'Medan', 'With thanks.', 6);
  return { ...state, records: [o1001, o1002, o1003, o1004], ids: { own: [o1001.no, o1003.no], victim: o1002.no, tobias: o1004.no } };
});
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Test seam: the seeded ids of session `sessionId` at `level`. */
export const idsFor = (sessionId: string, level: Level): SeededIds => labs.for({ sessionId, level }).ids;

/** The order with this id (ids are compared, never used as object keys), or undefined. */
export function findOrder(state: LabState, id: string): PlacedOrder | undefined {
  return state.records.find((o) => o.no === id);
}

/** The proof (the oracle, not the flaw): an order that is not the signed-in customer's. */
export function proves(order: Order): boolean {
  return order.owner !== CUSTOMER.id;
}
