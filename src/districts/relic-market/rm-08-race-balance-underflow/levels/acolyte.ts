import type { Result } from '../../../_shared/result.js';
import { SPEND, recordGift, recordPurchase, type LabState } from '../model.js';

// ACOLYTE — check, then wait for the ledger, then write: both endpoints check "do I have $15.00?", the ledger takes
// a second and a half, and only then is the credit reduced. The write RE-READS the credit, so two debits that were
// both checked against $20.00 take it to -$10.00 (an underflow, not a lost update).

const LEDGER_MS = 1500;

export async function buy(state: LabState): Promise<Result> {
  if (state.wallet < SPEND) return { ok: false, text: 'Insufficient store credit.' };
  await state.gate.pass(LEDGER_MS);
  state.wallet -= SPEND;
  return recordPurchase(state);
}

export async function gift(state: LabState, to: string): Promise<Result> {
  if (state.wallet < SPEND) return { ok: false, text: 'Insufficient store credit.' };
  await state.gate.pass(LEDGER_MS);
  state.wallet -= SPEND;
  return recordGift(state, to);
}
