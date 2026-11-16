import type { Result } from '../../../_shared/result.js';
import { addDiscount, clipText, formatMoney } from '../../_shared/shop.js';
import { VOUCHER, listSubtotal, type LabState } from '../model.js';

// INQUISITOR — a double-submit guard that is not atomicity: a request is refused while another request with the SAME
// raw input is being applied. Two things are wrong with it. The key is the raw text the player typed, so
// "firstrelic" and " FIRSTRELIC" are different keys for the same voucher once the body normalizes them; and the body
// is still check, then wait, then mark, so those two requests both pass the check.

const VALIDATION_MS = 1000;
const MAX_PENDING = 10;

export async function applyVoucher(state: LabState, raw: string): Promise<Result> {
  const key = clipText(raw); // a copy, clipped: the player's text never grows the guard
  if (state.inFlight.has(key)) return { ok: false, text: 'This voucher is already being applied.' };
  if (state.inFlight.size >= MAX_PENDING) return { ok: false, text: 'Too many pending requests.' };
  state.inFlight.add(key);
  try {
    const code = raw.trim().toUpperCase();
    if (code !== VOUCHER.code) return { ok: false, text: 'Unknown voucher.' };
    if (state.voucherUsed) return { ok: false, text: 'This voucher has already been used.' };
    if (listSubtotal(state) < VOUCHER.min) return { ok: false, text: `This voucher needs a subtotal of at least ${formatMoney(VOUCHER.min)}.` };
    await state.gate.pass(VALIDATION_MS);
    const applied = addDiscount(state, { code, amount: VOUCHER.amount });
    if (applied.ok) state.voucherUsed = true;
    return applied.ok ? { ok: true, text: `Voucher ${code} applied.` } : applied;
  } finally {
    state.inFlight.delete(key);
  }
}
