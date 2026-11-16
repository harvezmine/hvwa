import type { LabState } from '../model.js';

// ACOLYTE — "session ids in URLs make links shareable": any `?sid=` a page is opened with BECOMES that browser's
// session, even an id the server never issued (it is simply created). And signing in never changes the id. So pick
// an id, send the admin a link that carries it, and once the admin signs in, that id you chose is the admin's session.
export function sidFromUrl(state: LabState, query: URLSearchParams): string | undefined {
  const sid = query.get('sid');
  if (sid === null || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) return undefined;
  if (!state.sessions.has(sid)) state.sessions.set(sid, { user: null }); // whatever id the link names
  return sid;
}

export function signIn(state: LabState, sid: string, user: string, _nowMs: number): string {
  state.sessions.set(sid, { user }); // same id before and after signing in
  return sid;
}

export function whoIs(state: LabState, sid: string, _nowMs: number): string | undefined {
  return state.sessions.get(sid)?.user ?? undefined;
}

export function shareLink(_state: LabState, sid: string): string | undefined {
  return `/?sid=${sid}`;
}

export function resume(_state: LabState, _token: string): string | undefined {
  return undefined;
}
