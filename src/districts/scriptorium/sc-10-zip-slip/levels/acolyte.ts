import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { ZipEntry } from '../../../../core/upload-zip.js';
import type { Extracted } from '../model.js';

// ACOLYTE — no defense. Each entry name is joined onto the restore folder as it is written in the archive, so a name
// that climbs with ../ leaves the folder and overwrites any file the server can reach. (The files live in the lab's
// simulated file system; the simulated OS resolves the joined path, so that is where the write lands.)
export const separators: SimSeparators = '/';

export function extract(fs: SimFs, dir: string, entry: ZipEntry): Extracted {
  return { ok: true, path: fs.write(`${dir}/${entry.name}`, entry.bytes, { contentType: 'text/plain' }).path };
}
