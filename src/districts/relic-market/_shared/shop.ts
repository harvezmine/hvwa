// src/districts/relic-market/_shared/shop.ts — the Relic Market's shop model: catalog, cart, wallet and orders, with
// money in integer US cents. Pure plumbing shared by the shop labs: every parse rule, check, rounding rule and price
// decision lives in a lab's levels/*.ts, which hand this module what they decided. The bounds here are platform
// safety, not the lesson. Not a challenge: nothing here is served by View Source.
import { clip as copyingClip } from '../../../core/sim/limits.js';
import type { Result } from '../../_shared/result.js';
import { realClock, type LabClock } from './clock.js';
import { waitGate, type Gate } from './race.js';

/** A product. `price` is the server's list price in cents. */
export interface Product { readonly sku: string; readonly name: string; readonly price: number; readonly blurb: string }

/** A lab's product list: frozen, looked up by SKU in a Map (never an object index, so `constructor` is no product). */
export interface Catalog {
  readonly products: readonly Product[];
  get(sku: string): Product | undefined;
}

/** A cart line: what the level decided (quantity, unit price), stored as given. Return lines are their own lines. */
export interface CartLine { readonly sku: string; readonly qty: number; readonly unitPrice: number; readonly kind?: 'return' }

/** A discount applied to the cart (promotion labs). */
export interface Discount { readonly code: string; readonly amount: number }

/** An order line keeps what was bought at what price, so a lab's proof never reads the current catalog. */
export interface OrderLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  /** What the shop charged per unit. */
  readonly unitPrice: number;
  /** The catalog's list price when the order was placed. */
  readonly listPrice: number;
  readonly kind?: 'return';
}

export interface Order {
  readonly no: number;
  /** The customer id (CUSTOMER.id in every shop lab). */
  readonly owner: string;
  readonly lines: readonly OrderLine[];
  readonly discounts: readonly Discount[];
  readonly subtotal: number;
  readonly total: number;
  /** What the wallet was debited (negative = credited). */
  readonly charged: number;
  readonly status: string;
  /** clock.now() when it was placed. */
  readonly at: number;
}

/** One player's shop at one level (a lab's perSession state extends it). */
export interface ShopState {
  readonly catalog: Catalog;
  /** The wallet this instance started with: every proof is measured against it, so a Restart never helps. */
  readonly startWallet: number;
  wallet: number;
  readonly cart: CartLine[];
  readonly discounts: Discount[];
  /** Oldest first, at most LIMITS.orders. */
  readonly orders: Order[];
  nextOrderNo: number;
  /** The clock waits and timestamps use (a test seam). */
  clock: LabClock;
  /** The race window of racy levels (race.ts); tests replace it on one session's instance. */
  gate: Gate;
}

/** The shopper of every shop lab: already signed in, no sign-in form (authentication is not what these labs teach). */
export const CUSTOMER = Object.freeze({ username: 'pilgrim', id: 'C-1042', email: 'pilgrim@relic-market.test' });

/** Platform safety, not the lesson: bounds on everything a player can grow. */
export const LIMITS = Object.freeze({
  cartLines: 20,
  orders: 30,
  discounts: 10,
  history: 30,
  /** Largest |quantity| a cart line holds (above RM-14 Templar's 4 293 967 496). */
  qty: 9_999_999_999,
  /** Stored free text is clipped to this many characters. */
  text: 100,
});

/** The refusal when an amount would leave the safe integers (platform safety, never rounded). */
export const OUT_OF_RANGE = 'This amount is out of range for this shop.';

/**
 * Free text a lab STORES (a gift recipient, a voucher code, a history note): at most `n` characters (default
 * LIMITS.text), always as a new string. It is the engine's copying clip (core/sim/limits.ts): a plain slice() may be a
 * view that keeps the whole request body alive. sql.ts `clip` slices, so it is for display cells only, never storage.
 */
export function clipText(s: string, n: number = LIMITS.text): string {
  return copyingClip(s, n);
}

/** Append to a history list (exchanges, gifts, purchases): the newest LIMITS.history entries are kept. */
export function pushHistory<T>(list: T[], entry: T): void {
  list.push(entry);
  while (list.length > LIMITS.history) list.shift();
}

/**
 * Apply a discount to the cart, stored as given (the level decided its code and amount), as a copy with the code
 * clipped. Platform bound: at most LIMITS.discounts discounts. An amount that is not a safe integer throws.
 */
export function addDiscount(state: ShopState, d: Discount): Result {
  if (!Number.isSafeInteger(d.amount)) throw new TypeError(`addDiscount: amount ${d.amount} is not a safe integer`);
  if (state.discounts.length >= LIMITS.discounts) return { ok: false, text: `Too many promotions on this cart (${LIMITS.discounts}).` };
  const code = clipText(d.code);
  state.discounts.push(Object.freeze({ code, amount: d.amount }));
  return { ok: true, text: `Promotion ${code} applied.` };
}

const SKU_RE = /^[A-Z][A-Z0-9-]{0,31}$/;

/** A frozen catalog. Throws on a duplicate or malformed SKU, or a price that is not whole, safe, non-negative cents. */
export function catalogOf(products: readonly Product[]): Catalog {
  const bySku = new Map<string, Product>();
  for (const p of products) {
    if (!SKU_RE.test(p.sku)) throw new Error(`catalogOf: bad SKU "${p.sku}"`);
    if (bySku.has(p.sku)) throw new Error(`catalogOf: duplicate SKU ${p.sku}`);
    if (!Number.isSafeInteger(p.price) || p.price < 0) throw new Error(`catalogOf: ${p.sku} price must be whole cents >= 0`);
    bySku.set(p.sku, Object.freeze({ sku: p.sku, name: p.name, price: p.price, blurb: p.blurb }));
  }
  const list = Object.freeze([...bySku.values()]);
  return Object.freeze({ products: list, get: (sku: string) => bySku.get(sku) });
}

/** A fresh shop: the wallet (cents), an empty cart, no orders, order #1 next, the real clock and its gate. */
export function newShop(o: { readonly catalog: Catalog; readonly wallet: number }): ShopState {
  if (!Number.isSafeInteger(o.wallet)) throw new Error('newShop: the wallet must be a safe integer (cents)');
  return {
    catalog: o.catalog, startWallet: o.wallet, wallet: o.wallet,
    cart: [], discounts: [], orders: [], nextOrderNo: 1,
    clock: realClock, gate: waitGate(realClock),
  };
}

const labelOf = (state: ShopState, line: Pick<CartLine, 'sku' | 'kind'>): string => {
  const name = state.catalog.get(line.sku)?.name ?? line.sku;
  return line.kind === 'return' ? `${name} (return)` : name;
};

/**
 * Set the cart line of `line.sku` (a return line is its own line) to `line.qty`; 0 removes it. It stores what the
 * level decided without judging it (negative quantities and prices included) and only enforces the platform bounds:
 * |qty| <= LIMITS.qty and at most LIMITS.cartLines lines. A fractional quantity or an unsafe unit price is a programming
 * error (levels parse to integers) and throws.
 */
export function setLine(state: ShopState, line: CartLine): Result {
  const label = labelOf(state, line);
  if (!(Math.abs(line.qty) <= LIMITS.qty)) return { ok: false, text: 'Quantity too large for this shop.' };
  if (!Number.isInteger(line.qty)) throw new TypeError(`setLine: quantity ${line.qty} is not an integer`);
  if (!Number.isSafeInteger(line.unitPrice)) throw new TypeError(`setLine: unit price ${line.unitPrice} is not a safe integer`);
  const i = state.cart.findIndex((l) => l.sku === line.sku && l.kind === line.kind);
  if (line.qty === 0) {
    if (i >= 0) state.cart.splice(i, 1);
    return { ok: true, text: `Removed ${label} from your cart.` };
  }
  if (i < 0 && state.cart.length >= LIMITS.cartLines) return { ok: false, text: `Your cart is full (${LIMITS.cartLines} lines).` };
  const stored: CartLine = Object.freeze(line.kind === 'return'
    ? { sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, kind: 'return' as const }
    : { sku: line.sku, qty: line.qty, unitPrice: line.unitPrice });
  if (i >= 0) state.cart[i] = stored;
  else state.cart.push(stored);
  return { ok: true, text: `Cart updated: ${label} × ${line.qty}.` };
}

/** The cart as order lines: quantity and unit price as stored, name and list price from the catalog. */
export function orderLines(state: ShopState): OrderLine[] {
  return state.cart.map((l): OrderLine => {
    const p = state.catalog.get(l.sku);
    if (p === undefined) throw new Error(`orderLines: ${l.sku} is not in the catalog`);
    const line = { sku: l.sku, name: p.name, qty: l.qty, unitPrice: l.unitPrice, listPrice: p.price };
    return Object.freeze(l.kind === 'return' ? { ...line, kind: 'return' as const } : line);
  });
}

/** Add an order, keeping the newest LIMITS.orders (the oldest are dropped). */
export function pushOrder(state: ShopState, order: Order): void {
  state.orders.push(order);
  while (state.orders.length > LIMITS.orders) state.orders.shift();
}

/** What a lab's checkout decided to charge. */
export interface Checkout {
  readonly lines: readonly OrderLine[];
  readonly subtotal: number;
  readonly total: number;
  readonly charged: number;
}

/**
 * Place a paid order: debit `charged` (a negative charge credits), number it, stamp it with the clock, empty the cart
 * and the discounts, and keep it (pushOrder). Whether the order may be placed is the level's decision, made before.
 * Platform safety: a charge or a resulting wallet that is not a safe integer is refused (OUT_OF_RANGE), changing nothing.
 */
export function placeOrder(state: ShopState, c: Checkout): Order | string {
  const wallet = state.wallet - c.charged;
  if (!Number.isSafeInteger(c.charged) || !Number.isSafeInteger(wallet)) return OUT_OF_RANGE;
  const order: Order = Object.freeze({
    no: state.nextOrderNo, owner: CUSTOMER.id, lines: Object.freeze([...c.lines]), discounts: Object.freeze([...state.discounts]),
    subtotal: c.subtotal, total: c.total, charged: c.charged, status: 'paid', at: state.clock.now(),
  });
  state.wallet = wallet;
  state.nextOrderNo += 1;
  state.cart.length = 0;
  state.discounts.length = 0;
  pushOrder(state, order);
  return order;
}

/** The exact sum of qty x unitPrice over the lines, or undefined when it is not a safe integer (never rounded). */
export function cartTotal(lines: readonly CartLine[]): number | undefined {
  const sum = lines.reduce((s, l) => s + BigInt(l.qty) * BigInt(l.unitPrice), 0n);
  return safe(sum);
}

/** What an order's lines are really worth: the sum of listPrice x qty, exact (BigInt, beyond 2^53 too). */
export function exactValue(lines: readonly Pick<OrderLine, 'qty' | 'listPrice'>[]): bigint {
  return lines.reduce((s, l) => s + BigInt(l.listPrice) * BigInt(l.qty), 0n);
}

const safe = (b: bigint): number | undefined =>
  (b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(b) : undefined);

/** The cart as a lab computed it: each line's total (or why it has none), and the cart total (or why it has none). */
export interface CartTotals {
  readonly lines: readonly { readonly line: CartLine; readonly total: number | string }[];
  readonly total: number | string;
}

/** Exact cart totals: qty x unitPrice per line and their sum, each OUT_OF_RANGE when not a safe integer. */
export function exactTotals(state: ShopState): CartTotals {
  const lines = state.cart.map((line) => ({ line, total: safe(BigInt(line.qty) * BigInt(line.unitPrice)) ?? OUT_OF_RANGE }));
  return { lines, total: cartTotal(state.cart) ?? OUT_OF_RANGE };
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const isDecimal = (s: string): s is `${number}` => /^-?\d+\.\d\d$/.test(s);

/**
 * Integer cents as US dollars: `$1,000.00`, and `-$10.00` for negatives. The one money formatter: no level code
 * formats money itself. Exact for every integer: the amount goes to Intl as a decimal string, not as a float.
 */
export function formatMoney(cents: number): string {
  if (!Number.isInteger(cents)) return USD.format(cents / 100);
  const b = BigInt(cents); // BigInt(-0) is 0n, so zero is never "-$0.00"
  const abs = b < 0n ? -b : b;
  const decimal = `${b < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  // Intl.NumberFormat reads a numeric string as an exact decimal (ECMA-402 NumberFormat v3).
  return isDecimal(decimal) ? USD.format(decimal) : USD.format(cents / 100);
}

/** The refusal every shop lab's checkout gives when the wallet does not cover the total. */
export function insufficientFunds(total: number, wallet: number): string {
  return `Insufficient funds: the total is ${formatMoney(total)} and your wallet holds ${formatMoney(wallet)}.`;
}
