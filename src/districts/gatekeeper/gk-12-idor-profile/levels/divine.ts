import type { Access, RecordsLevel } from '../model.js';

// DIVINE — ownership comes from the session only (headers are never identity), ids are UUIDs
// and the directory prints names without ids, and a record that is not yours is answered
// exactly like one that does not exist (uniform "not found": no oracle for valid ids).
// Out of scope here: a production system would also log denied lookups and rate limit them.
export const idStyle: RecordsLevel['idStyle'] = 'uuid';
export const directoryShowsIds = false;
export const apiNote = '';
export const apiHeaders: RecordsLevel['apiHeaders'] = [];
export const uniformNotFound = true;
export function canRead(a: Access): boolean {
  return a.viewerId === a.ownerId;
}
