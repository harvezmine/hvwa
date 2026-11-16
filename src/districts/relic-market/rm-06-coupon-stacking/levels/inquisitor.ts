import type { Result } from '../../../_shared/result.js';
import { COUPONS, addCoupon, rawField, textOf, type LabState } from '../model.js';

// INQUISITOR — the real rule, "only one promotion per order", checked once PER REQUEST: if the cart already holds a
// promotion the request is refused. But the request may carry several codes (a repeated field, code[]=..., a JSON
// array), and every known, distinct one of them is appended after that single check.

export function applyCoupon(state: LabState, body: unknown): Result {
  if (state.coupons.length >= 1) return { ok: false, text: 'Only one promotion per order.' };
  const raw = rawField(body, 'code');
  const codes = (Array.isArray(raw) ? raw : [raw]).map((c) => textOf(c).trim().toUpperCase()).slice(0, 5);
  const known = [...new Set(codes)].filter((c) => COUPONS.has(c));
  if (known.length === 0) return { ok: false, text: 'Unknown promotion code.' };
  const results = known.map((c) => addCoupon(state, c));
  return { ok: results.every((r) => r.ok), text: results.map((r) => r.text).join(' ') };
}
