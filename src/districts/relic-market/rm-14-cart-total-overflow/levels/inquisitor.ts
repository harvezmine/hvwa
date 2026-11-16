import { insufficientFunds } from '../../_shared/shop.js';

// INQUISITOR — real defense for each line: the quantity is 1 to 9999 digits, and a line is computed exactly and
// refused when it does not fit in INT32. But the cart total is still summed as int32 with `| 0`, so several lines
// that each fit can wrap the sum, and checkout only refuses a total that is not positive.

const QTY = /^\d{1,4}$/;
const INT32_MAX = 2_147_483_647;

export function parseQty(raw: string): number | string {
  const qty = QTY.test(raw) ? Number(raw) : 0;
  return qty >= 1 ? qty : 'Quantity must be a whole number from 1 to 9999.';
}

export function lineTotal(price: number, qty: number): number | string {
  const line = price * qty;
  return line > INT32_MAX ? 'Line total too large.' : line;
}

export function addToTotal(total: number, line: number): number {
  return (total + line) | 0;
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  if (total <= 0) return 'Invalid order total.';
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
