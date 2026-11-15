import type { LabState } from '../model.js';

// ACOLYTE — session ids are a plain counter: 1001, 1002, 1003 ... Whoever signed in just
// before or after you has the id next to yours, so the admin's session is a few guesses away.
export function mint(state: LabState, _username: string): string {
  state.counter += 1;
  return String(state.counter);
}

export const showsLoginTime = false;
