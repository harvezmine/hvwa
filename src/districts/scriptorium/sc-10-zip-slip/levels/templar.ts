import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { ZipEntry } from '../../../../core/upload-zip.js';
import type { Extracted } from '../model.js';

// TEMPLAR — a naive filter. Every "../" in the entry name is removed, in ONE pass (replaceAll does not look at what
// its own removal leaves behind), and the name is joined onto the restore folder. Removing a bad substring is not
// the same as refusing a bad name: "....//" becomes "../" once the middle "../" is gone.
export const separators: SimSeparators = '/';

export function extract(fs: SimFs, dir: string, entry: ZipEntry): Extracted {
  const name = entry.name.replaceAll('../', '');
  return { ok: true, path: fs.write(`${dir}/${name}`, entry.bytes, { contentType: 'text/plain' }).path };
}
