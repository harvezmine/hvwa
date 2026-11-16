import { timingSafeEqual } from 'node:crypto';
import { describeFlow, findCheckout, pspCharge, signNotify, type CheckoutFlow, type LabState, type PayOutcome, type PspNotify } from '../model.js';
import type { Result } from '../../../_shared/result.js';

// DIVINE — secure reference: the steps run in order (shipping, then pay, then confirm), each transition is one-way and
// happens once, and only the payment provider can say a payment succeeded. After a payment the provider makes a
// server-to-server call: `notify`, signed with HMAC-SHA256 over `checkout|amount|status` under a key only the provider
// and this server hold. The server verifies the signature in constant time and that the amount is the checkout's total
// before it moves the checkout to `paid`. The return page only DISPLAYS the server's state (the query is ignored), and
// `confirm` needs `paid` with the full amount received.
// In this lab the notify is an internal call (no public route, so no forgery surface to defend and no noise in the
// Diff); a real deployment receives it as a signed webhook, and would also make it idempotent per provider event id.
// ASVS 5.0 V2.3 (sequential steps, no skipping) and V4 (verify webhook authenticity).
// Out of scope here: replay protection by timestamp, retries, refunds and reconciliation with the provider's records.

/** A provider notify as the server receives it: the message and its signature (hex). */
export interface SignedNotify extends PspNotify { readonly signature: string }

/** Verify a notify and apply it; true only when it moved a checkout from shipping to paid. */
export function notify(state: LabState, msg: SignedNotify): boolean {
  const co = findCheckout(state, msg.checkout);
  if (co === undefined) return false;
  const want = Buffer.from(signNotify(state.pspKey, msg), 'hex');
  const got = Buffer.from(msg.signature, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  if (msg.amount !== co.total) return false;
  if (co.state !== 'shipping') return false;
  if (msg.status !== 'success') {
    co.declined = true;
    return false;
  }
  co.state = 'paid';
  co.paid = msg.amount;
  co.declined = false;
  return true;
}

export function pay(state: LabState, co: CheckoutFlow): PayOutcome {
  if (co.state !== 'shipping') return { kind: 'settled', status: 409, result: { ok: false, text: 'Add a shipping address first.' } };
  const status = pspCharge(state, co) ? 'success' : 'failed';
  const m: PspNotify = { checkout: co.id, amount: co.total, status };
  notify(state, { ...m, signature: signNotify(state.pspKey, m) }); // the provider's server-to-server call
  return { kind: 'redirect', status };
}

export function paymentReturn(_state: LabState, co: CheckoutFlow, _status: string): Result {
  return { ok: true, text: describeFlow(co) };
}

export function confirm(_state: LabState, co: CheckoutFlow, _req: { readonly stepCookie: string | undefined }): Result {
  if (co.state !== 'paid' || co.paid !== co.total) return { ok: false, text: 'Payment required.' };
  co.state = 'confirmed';
  return { ok: true, text: 'Confirmed.' };
}
