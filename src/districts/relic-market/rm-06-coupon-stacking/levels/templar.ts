import type { Result } from '../../../_shared/result.js';
import { COUPONS, addCoupon, rawField, type LabState } from '../model.js';

// TEMPLAR — naive rule: the SAME code twice is refused, but nothing counts how many promotions the cart holds, so
// different codes stack.

export function applyCoupon(state: LabState, body: unknown): Result {
  const code = String(rawField(body, 'code') ?? '').trim().toUpperCase();
  if (!COUPONS.has(code)) return { ok: false, text: 'Unknown promotion code.' };
  if (state.coupons.includes(code)) return { ok: false, text: 'This code is already applied.' };
  return addCoupon(state, code);
}
