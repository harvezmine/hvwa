import { insufficientFunds } from '../../_shared/shop.js';
import type { LabState } from '../model.js';

// DIVINE — secure reference: a quantity is digits only, 1 to 99, everywhere. A return is bounded by what you bought,
// minus what you already returned, minus the returns already waiting in your cart. Checkout needs
// 0 <= total <= wallet, and every price comes from the server's catalog (the route, at every level).
// ASVS 5.0 V2.2 (validate business limits) and V2.3 (business-logic integrity).
// Out of scope here: a real shop would also tie each return to the order it came from and to a return window.

const QTY = /^\d{1,2}$/;

export function parseQty(raw: string): number | string {
  const n = QTY.test(raw) ? Number(raw) : 0;
  return n >= 1 ? n : 'Quantity must be a whole number from 1 to 99.';
}

export function returnable(state: LabState, sku: string, n: number): true | string {
  const pending = state.cart.filter((l) => l.sku === sku && l.kind === 'return').reduce((sum, l) => sum - l.qty, 0);
  const left = (state.owned.get(sku) ?? 0) - (state.returned.get(sku) ?? 0) - pending;
  return n <= left ? true : `You can return at most ${Math.max(left, 0)} ${state.catalog.get(sku)?.name ?? sku}.`;
}

export function checkoutAllowed(total: number, wallet: number): true | string {
  if (total < 0) return 'The order total cannot be negative.';
  return total <= wallet ? true : insufficientFunds(total, wallet);
}
