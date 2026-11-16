import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// INQUISITOR — a real check, made on the wrong form of the name. Any dot-separated segment equal to "php" (any case)
// in the name AS SENT is refused. Only then is the name decoded once (percent sequences, the way a browser-built
// name arrives), and the decoded name is what is stored. The archive server maps the FIRST extension of the stored
// name, and, like C string code, ends the name at a NUL character. So a name that is clean when it is checked can
// mean something else once it is decoded: the check and the use see different names.
// (The simulated file system keeps the name exactly, NUL included; the truncation is the server's, here.)
export function store(fs: SimFs, file: UploadedFile): Stored {
  const raw = file.filename;
  if (raw.split('.').some((segment) => segment.toLowerCase() === 'php')) return { ok: false, text: 'Scrolls with a php extension are not accepted.' };
  const name = decodeURIComponent(raw); // decoded once, AFTER the check
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${name}`, file.bytes, { contentType: file.contentType }).path };
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  if (file === undefined) return { file, runs: false };
  const leaf = file.path.slice(file.path.lastIndexOf('/') + 1).split('\u0000')[0]; // the name ends at a NUL
  const first = leaf.split('.')[1]?.toLowerCase(); // the first extension
  return { file, runs: first === 'php' };
}
