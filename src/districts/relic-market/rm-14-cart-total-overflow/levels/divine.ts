import { formatMoney, insufficientFunds } from '../../_shared/shop.js';

// DIVINE — secure reference: quantities are 1 to 99 digits; every multiply and add is exact JavaScript arithmetic,
// checked with Number.isSafeInteger, never truncated; orders above $1,000,000.00 need a quote, a cap far inside the
// order service's INT32 column; and the total must be covered by the wallet.
// ASVS 5.0 V2.2 (validate numeric ranges, on the value actually used).
// With 20 lines of at most 99 units the sum cannot leave the safe integers; addToTotal still refuses to, and the
// error handler answers a generic 500 if it ever did.

const QTY = /^\d{1,2}$/;
const ORDER_CAP = 100_000_000;

export function parseQty(raw: string): number | string {
  const qty = QTY.test(raw) ? Number(raw) : 0;
  return qty >= 1 ? qty : 'Quantity must be a whole number from 1 to 99.';
}

export function lineTotal(price: number, qty: number): number | string {
  const line = price * qty;
  return Number.isSafeInteger(line) ? line : 'Line total too large.';
}

export function addToTotal(total: number, line: number): number {
  const sum = total + line;
  if (!Number.isSafeInteger(sum)) throw new RangeError('cart total out of range');
  return sum;
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  if (total > ORDER_CAP) return `Orders above ${formatMoney(ORDER_CAP)} need a quote.`;
  if (total < 0) return 'Invalid order total.';
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
