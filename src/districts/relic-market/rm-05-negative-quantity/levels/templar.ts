import { insufficientFunds } from '../../_shared/shop.js';
import type { LabState } from '../model.js';

// TEMPLAR — naive filter: a quantity that starts with '-' is refused before parseInt reads it.
// Returns need the item to have been bought at least once.

export function parseQty(raw: string): number | string {
  if (raw.startsWith('-')) return 'Quantity cannot be negative.';
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 'Quantity must be a number.' : n;
}

export function returnable(state: LabState, sku: string, _n: number): true | string {
  return (state.owned.get(sku) ?? 0) >= 1 ? true : 'You can only return items you have bought.';
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
