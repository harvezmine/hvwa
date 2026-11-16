import { formatMoney, insufficientFunds } from '../../_shared/shop.js';
import { describeFlow, pspCharge, type CheckoutFlow, type LabState, type PayOutcome } from '../model.js';
import type { Result } from '../../../_shared/result.js';

// ACOLYTE — no defense. Paying works (the provider charges the wallet and the checkout is marked paid), but nothing
// else cares: `confirm` never asks whether the payment step happened, so a checkout that was started and never paid
// is confirmed for shipping just the same.

export function pay(state: LabState, co: CheckoutFlow): PayOutcome {
  if (!pspCharge(state, co)) return { kind: 'settled', result: { ok: false, text: insufficientFunds(co.total, state.wallet) } };
  co.state = 'paid';
  co.paid = co.total;
  return { kind: 'settled', result: { ok: true, text: `Payment of ${formatMoney(co.total)} accepted.` } };
}

export function paymentReturn(_state: LabState, co: CheckoutFlow, _status: string): Result {
  return { ok: true, text: describeFlow(co) };
}

export function confirm(_state: LabState, co: CheckoutFlow, _req: { readonly stepCookie: string | undefined }): Result {
  co.state = 'confirmed';
  return { ok: true, text: 'Confirmed.' };
}
