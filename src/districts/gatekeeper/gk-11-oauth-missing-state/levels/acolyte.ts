import type { Flow, LabState, Purpose } from '../model.js';

// ACOLYTE — no state at all. Citadel starts a flow without one and finishes any callback that comes back, so it cannot
// tell a callback from its own flow apart from one that someone else's browser started. Get a code for YOUR
// Pilgrim-ID, make the signed-in admin open the link callback with it, and your Pilgrim-ID is linked to the admin's
// account: from then on "Sign in with Pilgrim-ID" as yourself lands in the admin's Citadel account.
export function issueState(_state: LabState, _flow: Flow): string | undefined {
  return undefined;
}

export function acceptState(_state: LabState, _returned: string | null, _session: string, _purpose: Purpose): { ok: boolean; flow?: Flow } {
  return { ok: true }; // never looked at
}

export const pkce = false;
