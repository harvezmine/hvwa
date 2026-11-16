import type { Doc, DocStore } from '../docstore.js';
import { raw } from '../model.js';

// ACOLYTE — no defense: the two body fields go into the query exactly as they arrived. A form field written like
// password[$ne]=x (or a JSON object) is parsed into an OBJECT, so the "password" is an operator expression, not text.
export function login(store: DocStore, body: unknown): Doc | null {
  return store.findOne({ username: raw(body, 'username'), password: raw(body, 'password') });
}
