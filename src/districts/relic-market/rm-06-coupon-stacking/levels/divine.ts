import type { Result } from '../../../_shared/result.js';
import { COUPONS, addCoupon, rawField, type LabState } from '../model.js';

// DIVINE — secure reference: the rule is "one promotion per order", so the cart has ONE promotion slot and applying a
// code replaces it, whatever else the request carries. The code is a plain string (a repeated field or an array is no
// code, so a request can never name more than one), normalized, and must be a known promotion. The discount itself is
// recomputed from the list prices every time the cart is shown or paid (model.ts walk), never stored.
// ASVS 5.0 V2.3 (enforce business rules server-side, once per business action).
// Out of scope here: a real shop would also bind a promotion to a customer, an expiry date and a use count.

export function applyCoupon(state: LabState, body: unknown): Result {
  const raw = rawField(body, 'code');
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!COUPONS.has(code)) return { ok: false, text: 'Unknown promotion code.' };
  state.coupons.length = 0;
  return addCoupon(state, code);
}
