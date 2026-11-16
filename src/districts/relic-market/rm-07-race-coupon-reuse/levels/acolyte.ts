import type { Result } from '../../../_shared/result.js';
import { addDiscount, formatMoney } from '../../_shared/shop.js';
import { VOUCHER, listSubtotal, type LabState } from '../model.js';

// ACOLYTE — check, then wait, then mark: the "already used" check runs, the promotions service takes a second, and
// only afterwards is the voucher marked as used. Two requests that arrive within that second both pass the check.

const VALIDATION_MS = 1000;

export async function applyVoucher(state: LabState, raw: string): Promise<Result> {
  const code = raw.trim().toUpperCase();
  if (code !== VOUCHER.code) return { ok: false, text: 'Unknown voucher.' };
  if (state.voucherUsed) return { ok: false, text: 'This voucher has already been used.' };
  if (listSubtotal(state) < VOUCHER.min) return { ok: false, text: `This voucher needs a subtotal of at least ${formatMoney(VOUCHER.min)}.` };
  await state.gate.pass(VALIDATION_MS);
  const applied = addDiscount(state, { code, amount: VOUCHER.amount });
  if (applied.ok) state.voucherUsed = true;
  return applied.ok ? { ok: true, text: `Voucher ${code} applied.` } : applied;
}
