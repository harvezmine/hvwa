import type { Result } from '../../../_shared/result.js';
import { SPEND, recordGift, recordPurchase, type LabState } from '../model.js';

// DIVINE — secure reference: ONE debit for every spending path. `debit` checks the credit and takes the amount in a
// single synchronous step, before any await, so no other request can observe the credit between the check and the
// write; the slow ledger write comes after, and a failure refunds the reservation.
// The SQL equivalent is one statement that checks and subtracts in a single step:
//   UPDATE wallets SET balance = balance - ? WHERE id = ? AND balance >= ?   -- then require changes === 1
// or a row lock held per wallet (SELECT ... FOR UPDATE inside a transaction).
// ASVS 5.0 V2.3 (atomic business operations, balances that cannot be overdrawn).
// Out of scope here: a real ledger is append-only and reconciled, and a payment service would be idempotent.

const LEDGER_MS = 400;

/** Check and take in one step: true when `amount` was reserved. Never awaits. */
function debit(state: LabState, amount: number): boolean {
  if (state.wallet < amount) return false;
  state.wallet -= amount;
  return true;
}

/** The ledger write, after the reservation: a failure gives the reserved amount back. */
async function spend(state: LabState, record: () => Result): Promise<Result> {
  if (!debit(state, SPEND)) return { ok: false, text: 'Insufficient store credit.' };
  let done = false;
  try {
    await state.gate.pass(LEDGER_MS);
    const result = record();
    done = true;
    return result;
  } finally {
    if (!done) state.wallet += SPEND; // the write failed: refund
  }
}

export function buy(state: LabState): Promise<Result> {
  return spend(state, () => recordPurchase(state));
}

export function gift(state: LabState, to: string): Promise<Result> {
  return spend(state, () => recordGift(state, to));
}
