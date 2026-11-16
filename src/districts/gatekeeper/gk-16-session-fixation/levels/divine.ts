import type { LabState } from '../model.js';

// DIVINE — secure reference: a session id only ever arrives in the cookie the server set, never in a URL, and there
// are no resume links. Signing in ROTATES the id (a fresh random one) and the old id dies at once, so whatever id a
// browser had before signing in, nobody else knowing it gains anything.
// Out of scope here: a production system would also expire sessions, mark the cookie Secure, and offer a real
// sign-out that ends the session on the server.
export function sidFromUrl(_state: LabState, _query: URLSearchParams): string | undefined {
  return undefined;
}

export function signIn(state: LabState, sid: string, user: string, _nowMs: number): string {
  const fresh = state.openSession(user);
  state.sessions.delete(sid);
  return fresh;
}

export function whoIs(state: LabState, sid: string, _nowMs: number): string | undefined {
  return state.sessions.get(sid)?.user ?? undefined;
}

export function shareLink(_state: LabState, _sid: string): string | undefined {
  return undefined;
}

export function resume(_state: LabState, _token: string): string | undefined {
  return undefined;
}
