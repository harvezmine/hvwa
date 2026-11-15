import type { Access, RecordsLevel } from '../model.js';

// TEMPLAR — a naive fix on one door only. The HTML page checks that the record is yours,
// but the JSON API (written later, "for the mobile app") never got the check.
export const idStyle: RecordsLevel['idStyle'] = 'numeric';
export const directoryShowsIds = true;
export const uniformNotFound = false;
export function canRead(a: Access): boolean {
  if (a.channel === 'page') return a.viewerId === a.ownerId;
  return true; // the API door forgot the ownership check
}
