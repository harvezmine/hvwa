import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { Read } from '../model.js';

// ACOLYTE — no defense. The requested name is appended to the public scrolls' directory as it arrives, so "../" climbs
// out of it and reaches any file the server can read. (The files live in the lab's simulated file system; the
// simulated OS resolves the joined path, so that is the file that is read.)
const PUBLIC = '/public';
export const separators: SimSeparators = '/';

export function read(fs: SimFs, file: string): Read {
  return { ok: true, file: fs.read(`${PUBLIC}/${file}`) };
}
