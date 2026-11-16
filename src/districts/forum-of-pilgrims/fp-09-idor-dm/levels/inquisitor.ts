import type { Access, DmLevel } from '../model.js';

// INQUISITOR — a real check on both doors and unguessable UUID ids, but the ids are not secret (the public activity feed
// prints each message's ref) and the API decides "who is asking" from the client-supplied X-User-Id header instead of
// the session.
export const idStyle: DmLevel['idStyle'] = 'uuid';
export const feedShowsRefs = true;
export const apiNote = 'The mobile app identifies the user to the API with an X-User-Id header.';
export const apiHeaders: DmLevel['apiHeaders'] = ['X-User-Id: <your username>'];
export const uniformNotFound = false;
export function canRead(a: Access): boolean {
  if (a.channel === 'page') return a.viewer === a.from || a.viewer === a.to;
  const asking = a.claimed ?? a.viewer; // trusts a header the client writes
  return asking === a.from || asking === a.to;
}
