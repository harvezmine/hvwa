import { randomBytes } from 'node:crypto';
import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// DIVINE — secure reference: nothing the uploader wrote becomes part of a stored name. An avatar is stored under an
// opaque server-made name with one fixed extension and a fixed content type, a name is NEVER decoded into a path or
// looked at for extensions, and nothing stored is ever handed to an interpreter: it is served as a download. A name
// is looked up by exact match against what is stored. Verbosity: the shell shows "Invalid request." for any error at
// this level. Out of scope: authentication, quotas beyond the file system's, and re-encoding the image itself
// (SC-09 covers content checks).
export function store(fs: SimFs, file: UploadedFile): Stored {
  const path = `${UPLOADS_DIR}/scroll-${randomBytes(6).toString('hex')}.bin`;
  return { ok: true, path: fs.write(path, file.bytes, { contentType: 'application/octet-stream' }).path };
}

export function serve(fs: SimFs, name: string): Served {
  return { file: fs.list(UPLOADS_DIR).find((f) => f.path === `${UPLOADS_DIR}/${name}`), runs: false };
}
