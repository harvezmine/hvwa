import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// ACOLYTE — no defense. Every scroll is stored under the name the uploader gave it, whatever the extension, and the
// archive server hands any stored .php or .ejs file to its interpreter when it is fetched (GET uploads?name=...).
// (The files live in the lab's simulated file system, and "running" one is the simulated interpreter: nothing real.)
export function store(fs: SimFs, file: UploadedFile): Stored {
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

const INTERPRETED = /\.(php|ejs)$/;

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  return { file, runs: file !== undefined && INTERPRETED.test(file.path) };
}
