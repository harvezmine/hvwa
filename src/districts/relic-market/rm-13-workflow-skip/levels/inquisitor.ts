import { pspCharge, type CheckoutFlow, type LabState, type PayOutcome } from '../model.js';
import type { Result } from '../../../_shared/result.js';

// INQUISITOR — the payment state lives on the server, and `confirm` requires it (state `paid`). The flaw is how a
// checkout becomes paid: paying sends the browser to the return page with the provider's answer in the URL, and
// `paymentReturn` believes the query. Anyone who opens the return URL with `status=success` marks the checkout paid;
// nothing proves the provider charged anything.

export function pay(state: LabState, co: CheckoutFlow): PayOutcome {
  return { kind: 'redirect', status: pspCharge(state, co) ? 'success' : 'failed' };
}

export function paymentReturn(_state: LabState, co: CheckoutFlow, status: string): Result {
  if (status === 'success' && co.state !== 'confirmed') {
    co.state = 'paid';
    co.paid = co.total;
    return { ok: true, text: 'Payment received.' };
  }
  if (status === 'failed') return { ok: false, text: 'Payment failed: the provider reported a failure.' };
  return { ok: true, text: co.state === 'paid' || co.state === 'confirmed' ? 'Payment received.' : 'Payment not received yet.' };
}

export function confirm(_state: LabState, co: CheckoutFlow, _req: { readonly stepCookie: string | undefined }): Result {
  if (co.state !== 'paid') return { ok: false, text: 'Payment required.' };
  co.state = 'confirmed';
  return { ok: true, text: 'Confirmed.' };
}
