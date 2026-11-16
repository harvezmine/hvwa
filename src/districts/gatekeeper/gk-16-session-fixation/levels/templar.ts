import type { LabState } from '../model.js';

// TEMPLAR — a naive fix: `?sid=` is honoured only for ids the server itself ISSUED, so invented ids no longer work.
// But an attacker can get a perfectly real id just by visiting the portal, and signing in still never changes the
// id. Send the admin a link with YOUR fresh id: once the admin signs in on it, your own browser is signed in as the admin.
export function sidFromUrl(state: LabState, query: URLSearchParams): string | undefined {
  const sid = query.get('sid');
  return sid !== null && state.sessions.has(sid) ? sid : undefined;
}

export function signIn(state: LabState, sid: string, user: string, _nowMs: number): string {
  state.sessions.set(sid, { user }); // still the same id before and after signing in
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
