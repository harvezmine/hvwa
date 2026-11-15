import { fieldsOf, setField, type User } from '../model.js';
import type { Result } from '../../_shared/lab.js';

// ACOLYTE — no defense. Every field of the request body is merged into the user record, so a
// client that adds "role" to its profile update simply becomes whatever it asks to be.
// (fieldsOf/setField only keep the process safe: they drop __proto__ and friends and bound the size.)
export const notice = '';
export function applyUpdate(user: User, body: unknown): Result {
  for (const [key, value] of fieldsOf(body)) setField(user, key, value);
  return { ok: true, text: 'Profile updated.' };
}
