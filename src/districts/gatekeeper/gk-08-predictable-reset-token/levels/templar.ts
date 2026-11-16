import { createHash } from 'node:crypto';
import { memberByEmail, remember, type LabState, type Member, type ResetForm } from '../model.js';

/** The day of a moment, as the server's (UTC) calendar has it: '2026-11-16'. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// TEMPLAR — naive "hashing": the token is md5(address + today's date). A hash looks random, but its input is not
// secret: the address is known and so is the date. Ask for the admin's reset, then hash the admin's address with
// today's date. (Your own reset mail shows the date the server goes by.)
export function issue(state: LabState, member: Member, nowMs: number): string {
  const token = createHash('md5').update(`${member.email}${dayOf(nowMs)}`).digest('hex');
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
