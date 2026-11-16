import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { Read } from '../model.js';

// DIVINE — secure reference: a path is never built from the input. The requested name is only ever a KEY into a fixed
// list of public scrolls (an exact match, in a Map, so "__proto__" or "toString" are plain misses), and what is read
// is the path the server wrote down for that key. Any other name, however spelled, gets the one uniform "No such
// scroll." (404), so a miss reveals nothing about which files exist. Nothing is decoded and nothing is joined.
// Verbosity: a read error shows "Invalid request." at this level. Out of scope: a real deployment would also serve
// files from a directory outside the web root with the OS's own access controls.
const SCROLLS: ReadonlyMap<string, string> = new Map([
  ['psalms.txt', '/public/psalms.txt'],
  ['litany.txt', '/public/litany.txt'],
  ['glossary.txt', '/public/glossary.txt'],
]);
export const separators: SimSeparators = '/';

export function read(fs: SimFs, file: string): Read {
  const path = SCROLLS.get(file);
  return { ok: true, file: path === undefined ? undefined : fs.read(path) };
}
