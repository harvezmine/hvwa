import { insufficientFunds } from '../../_shared/shop.js';
import type { LabState } from '../model.js';

// ACOLYTE — no defense: any integer is a quantity, negative ones included, and every return is accepted.
// The cart total is quantity x price summed, so a negative line pays for the others.

export function parseQty(raw: string): number | string {
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 'Quantity must be a number.' : n;
}

export function returnable(_state: LabState, _sku: string, _n: number): true | string {
  return true;
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
