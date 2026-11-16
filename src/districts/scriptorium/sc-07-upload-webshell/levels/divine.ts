import { randomBytes } from 'node:crypto';
import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// DIVINE — secure reference: the stored name and the served name are decoupled from anything the uploader wrote. A
// scroll is stored under a name the server makes (random, one fixed extension), with a fixed content type (the
// uploader's claim is not kept), and it is NEVER handed to an interpreter: scrolls are data, served as a download.
// A name is looked up by exact match against what is stored, never resolved from the request, so a name cannot
// reach another file. Verbosity: the shell shows "Invalid request." for any error at this level. Out of scope:
// authentication, per-player quotas beyond the file system's, and virus scanning of the stored bytes.
export function store(fs: SimFs, file: UploadedFile): Stored {
  const path = `${UPLOADS_DIR}/scroll-${randomBytes(6).toString('hex')}.bin`;
  return { ok: true, path: fs.write(path, file.bytes, { contentType: 'application/octet-stream' }).path };
}

export function serve(fs: SimFs, name: string): Served {
  return { file: fs.list(UPLOADS_DIR).find((f) => f.path === `${UPLOADS_DIR}/${name}`), runs: false };
}
