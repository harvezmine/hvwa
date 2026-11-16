import type { Doc, DocStore } from '../docstore.js';
import { raw } from '../model.js';

// DIVINE — secure reference: only strings are accepted (anything else is the same refusal as a wrong password), and the
// query is built by the app from `$eq` conditions on the normalised, lower-cased username and the exact password. No
// $where, no operator the client could supply, and a store error would be shown to Divine players only as a generic
// "Invalid request." by the route (tryDb), never as its message (CWE-209).
// ASVS 5.0 V1.2 (injection: NoSQL queries are built from typed values, never from client-supplied structures).
// Out of scope here: a production system would store a slow salted password hash instead of the password, compare
// in constant time, and rate-limit attempts.
export function login(store: DocStore, body: unknown): Doc | null | string {
  const username = raw(body, 'username');
  const password = raw(body, 'password');
  if (typeof username !== 'string' || typeof password !== 'string') return 'Invalid username or password.';
  return store.findOne({ username_lc: { $eq: username.normalize('NFKC').toLowerCase() }, password: { $eq: password } });
}
