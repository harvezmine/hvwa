import type { Flow, LabState, Purpose } from '../model.js';

// INQUISITOR — the state is now required, and it must be one Citadel ISSUED for this kind of flow. But Citadel never
// asks WHOSE flow it was: the state is not bound to the session that started it. Start a link flow yourself, keep its
// state together with your code, and the admin's browser finishes your flow on the admin's account.
export function issueState(state: LabState, flow: Flow): string | undefined {
  return state.newState(flow);
}

export function acceptState(state: LabState, returned: string | null, _session: string, purpose: Purpose): { ok: boolean; flow?: Flow } {
  if (returned === null) return { ok: false };
  const flow = state.flows.get(returned);
  if (flow === undefined || flow.purpose !== purpose) return { ok: false }; // issued, yes; by this session? never asked
  state.flows.delete(returned);
  return { ok: true, flow };
}

export const pkce = false;
