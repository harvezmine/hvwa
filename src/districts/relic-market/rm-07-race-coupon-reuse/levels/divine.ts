import type { Result } from '../../../_shared/result.js';
import { addDiscount, formatMoney } from '../../_shared/shop.js';
import { VOUCHER, listSubtotal, type LabState } from '../model.js';

// DIVINE — secure reference: an atomic reservation. The voucher is normalized, checked AND marked as used in the same
// synchronous step, before any await, so a second request can never observe it as unused. The slow validation comes
// after; if it fails the reservation is given back (finally), and the cart refuses a second FIRSTRELIC discount
// whatever the flag says.
// The SQL equivalent is one statement that checks and takes in a single step:
//   UPDATE vouchers SET redeemed_by = ? WHERE code = ? AND redeemed_by IS NULL   -- then require changes === 1
// or SELECT ... FOR UPDATE inside a transaction. challengeDb rejects BEGIN, so this lab shows the same idea in JS.
// ASVS 5.0 V2.3 (atomic business operations, single-use resources).
// Out of scope here: a real shop would also bind the voucher to the customer in the database, not in a session.

const VALIDATION_MS = 1000;

export async function applyVoucher(state: LabState, raw: string): Promise<Result> {
  const code = raw.trim().toUpperCase();
  if (code !== VOUCHER.code) return { ok: false, text: 'Unknown voucher.' };
  if (state.voucherUsed || state.discounts.some((d) => d.code === VOUCHER.code)) return { ok: false, text: 'This voucher has already been used.' };
  if (listSubtotal(state) < VOUCHER.min) return { ok: false, text: `This voucher needs a subtotal of at least ${formatMoney(VOUCHER.min)}.` };
  state.voucherUsed = true; // reserved here, in the same synchronous step as the check above
  let applied = false;
  try {
    await state.gate.pass(VALIDATION_MS);
    applied = addDiscount(state, { code, amount: VOUCHER.amount }).ok;
    return applied ? { ok: true, text: `Voucher ${code} applied.` } : { ok: false, text: 'The voucher could not be applied.' };
  } finally {
    if (!applied) state.voucherUsed = false; // the validation failed: give the voucher back
  }
}
