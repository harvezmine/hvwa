import { formatMoney, insufficientFunds } from '../../_shared/shop.js';
import { flowResult, pspCharge, stepCookie, type CheckoutFlow, type LabState, type PayOutcome } from '../model.js';
import type { Result } from '../../../_shared/result.js';

// TEMPLAR — the payment step leaves a note in the BROWSER: after a successful payment the response sets the cookie
// `relic_step_templar=paid` (not HttpOnly), and `confirm` checks only that client-held cookie, never the checkout's own
// state on the server. Whoever can write a cookie can say the step happened.

export function pay(state: LabState, co: CheckoutFlow): PayOutcome {
  if (!pspCharge(state, co)) return { kind: 'settled', result: { ok: false, text: insufficientFunds(co.total, state.wallet) } };
  co.state = 'paid';
  co.paid = co.total;
  return {
    kind: 'settled', result: { ok: true, text: `Payment of ${formatMoney(co.total)} accepted.` },
    cookie: { name: stepCookie('templar'), value: 'paid' },
  };
}

export function paymentReturn(_state: LabState, co: CheckoutFlow, _status: string): Result {
  return flowResult(co);
}

export function confirm(_state: LabState, co: CheckoutFlow, req: { readonly stepCookie: string | undefined }): Result {
  if (req.stepCookie !== 'paid') return { ok: false, text: 'Payment required.' };
  co.state = 'confirmed';
  return { ok: true, text: 'Confirmed.' };
}
