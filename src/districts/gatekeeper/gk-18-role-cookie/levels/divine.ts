import { randomBytes } from 'node:crypto';
import { MAX_SESSIONS, type Identity, type LabState } from '../model.js';

// DIVINE — the cookie carries nothing but an opaque random session id (256 bits, HttpOnly). The
// user and the role live on the server, in the session store, and are looked up on every request:
// there is nothing in the cookie to edit.
// Out of scope here: a production system would also expire and rotate sessions (at login and on
// privilege change), mark the cookie Secure, and bind it to the client where that makes sense.
export const httpOnly = true;
export function issue(state: LabState, who: Identity): string {
  const id = randomBytes(32).toString('hex');
  state.sessions.set(id, { user: who.user, role: who.role });
  while (state.sessions.size > MAX_SESSIONS) {
    const oldest = state.sessions.keys().next().value;
    if (oldest === undefined) break;
    state.sessions.delete(oldest);
  }
  return id;
}
export function read(state: LabState, cookie: unknown): Identity | undefined {
  return typeof cookie === 'string' ? state.sessions.get(cookie) : undefined;
}
