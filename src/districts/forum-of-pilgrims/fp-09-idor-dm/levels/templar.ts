import type { Access, DmLevel } from '../model.js';

// TEMPLAR — a naive fix on one door only. The HTML page checks that you are a party to the message, but the JSON API
// (written later, "for the mobile app") never got the check. Ids are still sequential.
export const idStyle: DmLevel['idStyle'] = 'numeric';
export const feedShowsRefs = true;
export const apiNote = '';
export const apiHeaders: DmLevel['apiHeaders'] = [];
export const uniformNotFound = false;
export function canRead(a: Access): boolean {
  if (a.channel === 'page') return a.viewer === a.from || a.viewer === a.to;
  return true; // the API door forgot the ownership check
}
