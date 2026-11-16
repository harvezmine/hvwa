import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { ZipEntry } from '../../../../core/upload-zip.js';
import type { Extracted } from '../model.js';

// DIVINE — secure reference: canonicalize, then contain. Each entry is resolved under the restore folder by the
// simulated OS's own rules (the same split on both separators the server uses) and refused unless the RESOLVED path is
// strictly inside that folder. Absolute names, drive letters, backslashes and NUL are refused outright as well, and a
// refused entry is listed and skipped; the rest of the archive still extracts. The containment test is on the
// resolved path, never on the text of the name, so no spelling of "up" gets past it.
// Verbosity: a storage error shows "Invalid request." at this level. Out of scope: symlinks (the simulated file
// system has none), file-type checks, and quotas beyond the file system's.
export const separators: SimSeparators = '/\\';

export function extract(fs: SimFs, dir: string, entry: ZipEntry): Extracted {
  const name = entry.name;
  if (name.includes('\u0000')) return { ok: false, text: 'the name contains a NUL character.' };
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return { ok: false, text: 'absolute and backslash names are not accepted.' };
  const base = fs.resolve(dir);
  const key = fs.resolve(`${base}/${name}`);
  // Inside the root is anything but the root itself; inside any other directory is under `<dir>/`.
  const inside = base === '/' ? key !== '/' : key.startsWith(`${base}/`);
  if (!inside) return { ok: false, text: `it would land outside ${base}.` };
  return { ok: true, path: fs.write(key, entry.bytes, { contentType: 'text/plain' }).path };
}
