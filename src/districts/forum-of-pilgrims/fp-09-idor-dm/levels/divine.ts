import type { Access, DmLevel } from '../model.js';

// DIVINE — who is asking comes from the session only (a header is never an identity), ids are UUIDs, the public feed
// prints no refs, and a message that is not yours is answered exactly like one that does not exist (uniform "not found":
// no oracle for valid ids). The refusal text itself is the same for both doors (see uniformNotFound in challenge.ts).
// Out of scope here: a production system would also log denied lookups and rate limit them.
export const idStyle: DmLevel['idStyle'] = 'uuid';
export const feedShowsRefs = false;
export const apiNote = '';
export const apiHeaders: DmLevel['apiHeaders'] = [];
export const uniformNotFound = true;
export function canRead(a: Access): boolean {
  return a.viewer === a.from || a.viewer === a.to;
}
