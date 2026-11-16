import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// ACOLYTE — no defense. Every avatar is stored under the name it was uploaded with, and the archive server hands a
// file to its interpreter whenever its name CONTAINS ".php" anywhere (an Apache-style multi-extension mapping:
// avatar.php.jpg runs as PHP too). (The files live in the lab's simulated file system, and "running" one is the
// simulated interpreter: nothing real.)
export function store(fs: SimFs, file: UploadedFile): Stored {
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  return { file, runs: file !== undefined && file.path.includes('.php') };
}
