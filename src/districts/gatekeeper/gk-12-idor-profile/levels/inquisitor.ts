import type { Access, RecordsLevel } from '../model.js';

// INQUISITOR — a real check on both doors and unguessable UUID ids, but the ids are not secret
// (the public team directory prints them) and the API decides "who is asking" from the
// client-supplied X-User-Id header instead of the session.
export const idStyle: RecordsLevel['idStyle'] = 'uuid';
export const directoryShowsIds = true;
export const uniformNotFound = false;
export function canRead(a: Access): boolean {
  if (a.channel === 'page') return a.viewerId === a.ownerId;
  const asking = a.claimedId ?? a.viewerId; // trusts a header the client writes
  return asking === a.ownerId;
}
