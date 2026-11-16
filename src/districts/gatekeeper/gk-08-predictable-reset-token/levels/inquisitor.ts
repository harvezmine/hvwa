import { randomBytes } from 'node:crypto';
import { memberByEmail, remember, type LabState, type Member, type ResetForm } from '../model.js';

// INQUISITOR — the token itself is fine: 16 random bytes from the CSPRNG, used once. But it is not bound to an
// account. The link carries the address and the form has an email field, and the reset checks only that the
// token EXISTS before changing the password of whatever address the form names. Ask for a reset of your own
// account, then use your own token with the admin's address.
export function issue(state: LabState, member: Member, _nowMs: number): string {
  const token = randomBytes(16).toString('hex');
  remember(state, token, { email: member.email });
  return token;
}

export function redeem(state: LabState, form: ResetForm, _nowMs: number): Member | undefined {
  if (!state.resets.has(form.token)) return undefined;
  state.resets.delete(form.token);
  return memberByEmail(state, form.email); // the form says whose password changes, not the token
}

export const formHasEmail = true;
