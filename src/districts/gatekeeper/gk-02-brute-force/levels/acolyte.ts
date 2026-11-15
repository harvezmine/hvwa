import type { LabState, LoginOutcome } from '../model.js';
import { accounts } from '../model.js';

// ACOLYTE — no defense. There is no attempt limit at all, and the two failure
// messages differ, so an attacker first learns which usernames exist (enumeration)
// and then walks a password list against the one that does.
export function login(state: LabState, username: string, password: string): LoginOutcome {
  const account = accounts(state).find((a) => a.username === username);
  if (!account) return { ok: false, message: 'Unknown user.' };
  if (account.password !== password) return { ok: false, message: 'Wrong password for this user.' };
  return { ok: true, account };
}
