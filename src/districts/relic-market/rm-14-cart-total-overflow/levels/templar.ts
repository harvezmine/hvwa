import { insufficientFunds } from '../../_shared/shop.js';

// TEMPLAR — naive sanity check: a total that is not positive is refused at checkout. The arithmetic is still int32:
// the quantity is validated as a JavaScript number (>= 1) and only then truncated with `qty | 0` inside the line,
// so a ten-digit quantity can wrap its own line negative while the total stays just above zero.

export function parseQty(raw: string): number | string {
  const qty = Number.parseInt(raw, 10);
  return qty >= 1 ? qty : 'Quantity must be at least 1.';
}

export function lineTotal(price: number, qty: number): number | string {
  return Math.imul(price, qty | 0);
}

export function addToTotal(total: number, line: number): number {
  return (total + line) | 0;
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  if (total <= 0) return 'Invalid order total.';
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
