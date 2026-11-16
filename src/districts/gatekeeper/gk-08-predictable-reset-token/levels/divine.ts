import { createHash, randomBytes } from 'node:crypto';
import { memberByEmail, remember, type LabState, type Member, type ResetForm } from '../model.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

// DIVINE — secure reference: 32 bytes from the operating system's CSPRNG, so the token says nothing about the
// account, the time or any other token. Only its SHA-256 hash is stored (a leaked table holds no working link),
// bound to the account it was sent for. The form's own fields never pick the account: the stored record does.
// A link works once and for 15 minutes.
// Out of scope here: a production system would also rate-limit reset requests, tell the account owner that the
// password changed, and end the account's other sessions after a reset.
export function issue(state: LabState, member: Member, nowMs: number): string {
  const token = randomBytes(32).toString('base64url');
  remember(state, hash(token), { email: member.email, expiresAt: nowMs + FIFTEEN_MINUTES });
  return token;
}

export function redeem(state: LabState, form: ResetForm, nowMs: number): Member | undefined {
  const key = hash(form.token);
  const record = state.resets.get(key);
  if (record === undefined) return undefined;
  state.resets.delete(key); // single use, even when it has expired
  if (record.expiresAt === undefined || nowMs >= record.expiresAt) return undefined;
  return memberByEmail(state, record.email);
}

export const formHasEmail = false;
