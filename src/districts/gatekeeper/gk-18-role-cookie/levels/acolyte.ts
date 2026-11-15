import type { Identity, LabState } from '../model.js';

// ACOLYTE — no defense. The cookie is just the role ("user"), and the server believes it.
export const httpOnly = false;
export function issue(_state: LabState, who: Identity): string {
  return who.role;
}
export function read(_state: LabState, cookie: unknown): Identity | undefined {
  if (typeof cookie !== 'string' || cookie === '') return undefined;
  return { user: 'pilgrim', role: cookie } satisfies Identity; // trusts whatever the client says
}
