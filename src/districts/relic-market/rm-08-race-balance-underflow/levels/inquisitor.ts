import type { Result } from '../../../_shared/result.js';
import { SPEND, recordGift, recordPurchase, type LabState } from '../model.js';

// INQUISITOR — a real lock, on the wrong thing. Each endpoint serializes ITS OWN requests (one lock named "buy", one
// named "gift"), so two buys can never interleave: the second sees what the first left. But the credit is one wallet
// that two endpoints spend from, and a buy and a gift hold different locks, so they run at the same time.
// (The route arrives at the gate before it calls these, so a request queued on a lock still counts as arrived.)

const LEDGER_MS = 400;

export function buy(state: LabState): Promise<Result> {
  return state.locks.run('buy', async () => {
    if (state.wallet < SPEND) return { ok: false, text: 'Insufficient store credit.' };
    await state.gate.pass(LEDGER_MS);
    state.wallet -= SPEND;
    return recordPurchase(state);
  });
}

export function gift(state: LabState, to: string): Promise<Result> {
  return state.locks.run('gift', async () => {
    if (state.wallet < SPEND) return { ok: false, text: 'Insufficient store credit.' };
    await state.gate.pass(LEDGER_MS);
    state.wallet -= SPEND;
    return recordGift(state, to);
  });
}
