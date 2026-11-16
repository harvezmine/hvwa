import type { Flow, LabState, Purpose } from '../model.js';

// DIVINE — secure reference: every flow carries a random state that Citadel remembers WITH the session that started
// it. A callback is finished only by that same session, with that state, for that purpose, and only once. Flows also
// use PKCE, so a code is worthless without the verifier Citadel kept for the flow. A callback URL someone else's
// browser opens can therefore never finish your flow, nor you theirs.
// Out of scope here: a production client would also confirm a new link (e.g. by mail) and show its linked accounts.
export function issueState(state: LabState, flow: Flow): string | undefined {
  return state.newState(flow);
}

export function acceptState(state: LabState, returned: string | null, session: string, purpose: Purpose): { ok: boolean; flow?: Flow } {
  if (returned === null) return { ok: false };
  const flow = state.flows.get(returned);
  state.flows.delete(returned); // single use
  return flow !== undefined && flow.session === session && flow.purpose === purpose ? { ok: true, flow } : { ok: false };
}

export const pkce = true;
