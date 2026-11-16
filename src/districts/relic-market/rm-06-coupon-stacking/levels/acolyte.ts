import type { Result } from '../../../_shared/result.js';
import { COUPONS, addCoupon, rawField, type LabState } from '../model.js';

// ACOLYTE — no defense: any known code is appended, even one that is already applied, so RELIC20 stacks on itself.
// (An array still becomes one string, "A,B", which is no code: only the code's own spelling is normalized.)

export function applyCoupon(state: LabState, body: unknown): Result {
  const code = String(rawField(body, 'code') ?? '').trim().toUpperCase();
  if (!COUPONS.has(code)) return { ok: false, text: 'Unknown promotion code.' };
  return addCoupon(state, code);
}
