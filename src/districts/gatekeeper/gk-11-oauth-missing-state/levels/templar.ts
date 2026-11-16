import type { Flow, LabState, Purpose } from '../model.js';

// TEMPLAR — a state is sent, remembered with the session that started the flow, and checked properly... but only
// WHEN THE CALLBACK CARRIES ONE. A callback without any state is waved through as if the check had passed. So the
// fix is undone by simply leaving the parameter out of the link callback you send the admin.
export function issueState(state: LabState, flow: Flow): string | undefined {
  return state.newState(flow);
}

export function acceptState(state: LabState, returned: string | null, session: string, purpose: Purpose): { ok: boolean; flow?: Flow } {
  if (returned === null) return { ok: true }; // no state, nothing to check
  const flow = state.flows.get(returned);
  if (flow === undefined || flow.session !== session || flow.purpose !== purpose) return { ok: false };
  state.flows.delete(returned);
  return { ok: true, flow };
}

export const pkce = false;
