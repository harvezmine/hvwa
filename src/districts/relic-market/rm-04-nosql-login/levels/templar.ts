import type { Doc, DocStore } from '../docstore.js';
import { raw } from '../model.js';

// TEMPLAR — naive filter: a value that is an object with its own key $ne or $gt is refused. The blacklist is two names
// long: the store has more operators ($regex, $gte, $lt, $nin, $exists, $not, ...) and they all pass.
const blocked = (v: unknown): boolean => typeof v === 'object' && v !== null && (Object.hasOwn(v, '$ne') || Object.hasOwn(v, '$gt'));

export function login(store: DocStore, body: unknown): Doc | null | string {
  const username = raw(body, 'username');
  const password = raw(body, 'password');
  if (blocked(username) || blocked(password)) return 'Hacking attempt blocked.';
  return store.findOne({ username, password });
}
