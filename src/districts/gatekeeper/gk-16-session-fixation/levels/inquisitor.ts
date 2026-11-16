import { randomBytes } from 'node:crypto';
import type { LabState } from '../model.js';

const GRACE_MS = 60_000;

// INQUISITOR — a real defense, subtly flawed. No ids in URLs any more, and signing in ROTATES the id. But two
// conveniences undo it: a "resume link" (/resume?token=) sets a session in another browser, and after a sign-in the
// old id stays valid as an alias of the new session for a 60-second "grace period" (so tabs that still hold it keep
// working). Send the admin your resume link: the admin signs in on your session, and for a minute your old id is the admin.
export function sidFromUrl(_state: LabState, _query: URLSearchParams): string | undefined {
  return undefined;
}

export function signIn(state: LabState, sid: string, user: string, nowMs: number): string {
  const fresh = state.openSession(user);
  state.sessions.delete(sid);
  state.aliases.set(sid, { to: fresh, until: nowMs + GRACE_MS }); // the grace period
  return fresh;
}

export function whoIs(state: LabState, sid: string, nowMs: number): string | undefined {
  const session = state.sessions.get(sid);
  if (session !== undefined) return session.user ?? undefined;
  const alias = state.aliases.get(sid);
  if (alias === undefined || nowMs >= alias.until) return undefined;
  return state.sessions.get(alias.to)?.user ?? undefined;
}

export function shareLink(state: LabState, sid: string): string | undefined {
  let token = [...state.resumes].find(([, s]) => s === sid)?.[0];
  if (token === undefined) {
    token = randomBytes(16).toString('hex');
    state.resumes.set(token, sid);
  }
  return `/resume?token=${token}`;
}

export function resume(state: LabState, token: string): string | undefined {
  return state.resumes.get(token);
}
