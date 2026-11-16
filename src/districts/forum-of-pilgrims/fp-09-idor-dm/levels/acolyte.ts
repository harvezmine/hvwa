import type { Access, DmLevel } from '../model.js';

// ACOLYTE — no defense. Sequential numeric ids (the admin's private message is 1) and no ownership check on either
// door: whoever is signed in can read any message they can name.
export const idStyle: DmLevel['idStyle'] = 'numeric';
export const feedShowsRefs = true;
export const apiNote = '';
export const apiHeaders: DmLevel['apiHeaders'] = [];
export const uniformNotFound = false;
export function canRead(_a: Access): boolean {
  return true;
}
