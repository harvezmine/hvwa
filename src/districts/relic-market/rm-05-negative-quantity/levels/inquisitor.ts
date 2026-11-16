import { insufficientFunds } from '../../_shared/shop.js';
import type { LabState } from '../model.js';

// INQUISITOR — real defense for quantities: digits only, 1 to 99, on every form, and checkout refuses a negative
// total. The one feature that adds a negative line on purpose, "return for store credit", checks that you bought
// the item, but not how many you bought.

const QTY = /^\d{1,2}$/;

export function parseQty(raw: string): number | string {
  const n = QTY.test(raw) ? Number(raw) : 0;
  return n >= 1 ? n : 'Quantity must be a whole number from 1 to 99.';
}

export function returnable(state: LabState, sku: string, _n: number): true | string {
  return (state.owned.get(sku) ?? 0) >= 1 ? true : 'You can only return items you have bought.';
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  if (total < 0) return 'The order total cannot be negative.';
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
