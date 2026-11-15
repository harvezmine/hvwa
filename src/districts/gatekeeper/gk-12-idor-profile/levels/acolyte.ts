import type { Access, RecordsLevel } from '../model.js';

// ACOLYTE — no defense. Sequential numeric ids (the admin is 1) and no ownership check on
// either door: whoever is signed in can read any record they can name.
export const idStyle: RecordsLevel['idStyle'] = 'numeric';
export const directoryShowsIds = true;
export const uniformNotFound = false;
export function canRead(_a: Access): boolean {
  return true;
}
