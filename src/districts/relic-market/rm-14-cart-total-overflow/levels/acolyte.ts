import { insufficientFunds } from '../../_shared/shop.js';

// ACOLYTE — no defense: like a Java or C `int`, the order service keeps cents in a signed 32-bit integer.
// Math.imul multiplies as int32 and `| 0` truncates to int32, so a big line or total silently wraps around,
// and checkout only asks whether the (wrapped) total fits in the wallet.

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
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
