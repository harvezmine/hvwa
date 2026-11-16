import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { Read } from '../model.js';

// TEMPLAR — a naive filter. Every "../" in the name is removed, in ONE pass (replaceAll does not look at what its own
// removal leaves behind), and the rest is appended to the public scrolls' directory. Removing a bad substring is not
// the same as refusing a bad name: "....//" becomes "../" once the middle "../" is gone.
const PUBLIC = '/public';
export const separators: SimSeparators = '/';

export function read(fs: SimFs, file: string): Read {
  return { ok: true, file: fs.read(`${PUBLIC}/${file.replaceAll('../', '')}`) };
}
