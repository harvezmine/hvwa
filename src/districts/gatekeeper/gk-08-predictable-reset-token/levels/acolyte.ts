import { memberByEmail, remember, type LabState, type Member, type ResetForm } from '../model.js';

// ACOLYTE — the "token" is just the account's address, base64url-encoded. It looks like gibberish, but anyone
// who knows an address can write that account's token themselves: ask for the admin's reset, then encode the
// admin's address. Encoding is not secrecy.
export function issue(state: LabState, member: Member, _nowMs: number): string {
  const token = Buffer.from(member.email, 'utf8').toString('base64url');
  remember(state, token, { email: member.email });
  return token;
}

export function redeem(state: LabState, form: ResetForm, _nowMs: number): Member | undefined {
  const record = state.resets.get(form.token);
  if (record === undefined) return undefined;
  state.resets.delete(form.token);
  return memberByEmail(state, record.email);
}

export const formHasEmail = false;
