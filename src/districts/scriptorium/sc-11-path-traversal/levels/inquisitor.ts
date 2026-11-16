import type { SimFs, SimSeparators } from '../../../../core/simfs.js';
import type { Read } from '../model.js';

// INQUISITOR — a real check, made before the last decoding. The name as it arrives (Express has already decoded the
// query string once, so "%2e%2e%2f" arrives as "../" and is caught here) is refused if it has a ".." segment on
// either separator (this server is Windows-style) or starts at the root. THEN the name is URL-decoded once more,
// and that decoded name is what is read: a doubly encoded "%252e%252e%252f" passes the check as plain text and
// turns into "../" afterwards. Filter-then-decode is not decode-then-filter. The intended way in is double
// encoding (this level reads the query string the way Express hands it over; it does not read the raw query).
// The join below restarts at an absolute name, as Python's os.path.join does, so a decoded "/..." ignores the
// public directory.
const PUBLIC = '/public';
export const separators: SimSeparators = '/\\';

export function read(fs: SimFs, file: string): Read {
  if (file.split(/[\\/]/).includes('..') || file.startsWith('/') || file.startsWith('\\')) return { ok: false, text: 'That name is not allowed.' };
  const name = decodeURIComponent(file); // decoded AFTER the check
  const path = name.startsWith('/') ? name : `${PUBLIC}/${name}`; // an absolute name resets the join
  return { ok: true, file: fs.read(path) };
}
