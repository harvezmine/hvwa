import { posix } from 'node:path';
import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { ZipEntry } from '../../../../core/upload-zip.js';
import type { Extracted } from '../model.js';

// INQUISITOR — a real check, written for one kind of path. The entry name is normalized the POSIX way, and a name that
// still starts with ".." (it climbs out of the restore folder) is refused. Two things are not covered: this
// server is Windows-style, so a backslash is a separator too (the check never sees "..\" as a climb); and the join
// below restarts at an absolute name, as Python's os.path.join does, so "/srv/app/..." ignores the restore folder.
export const separators: SimSeparators = '/\\';

export function extract(fs: SimFs, dir: string, entry: ZipEntry): Extracted {
  const clean = posix.normalize(entry.name);
  if (clean === '..' || clean.startsWith('../')) return { ok: false, text: 'entry names may not climb out of the restore folder.' };
  const target = entry.name.startsWith('/') ? entry.name : `${dir}/${entry.name}`; // an absolute name resets the join
  return { ok: true, path: fs.write(target, entry.bytes, { contentType: 'text/plain' }).path };
}
