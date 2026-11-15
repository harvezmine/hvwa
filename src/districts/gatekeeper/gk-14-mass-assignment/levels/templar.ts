import { fieldsOf, isPlainObject, setField, type User } from '../model.js';
import type { Result } from '../../_shared/lab.js';

// TEMPLAR — a naive filter. The top-level "role" key is dropped, but the update accepts grouped
// sections ({ account: {...} }) and the deep merge flattens every nested section onto the same
// record without looking at the keys again: { account: { role } } gets through.
// (fieldsOf/setField only keep the process safe: they drop __proto__ and friends and bound the size.)
function deepMerge(user: User, body: unknown, depth: number): void {
  for (const [key, value] of fieldsOf(body)) {
    if (isPlainObject(value) && depth < 5) deepMerge(user, value, depth + 1);
    else setField(user, key, value);
  }
}

export const notice = '';
export function applyUpdate(user: User, body: unknown): Result {
  const top = fieldsOf(body).filter(([key]) => key !== 'role'); // strip role (top level only)
  deepMerge(user, Object.fromEntries(top), 0);
  return { ok: true, text: 'Profile updated.' };
}
