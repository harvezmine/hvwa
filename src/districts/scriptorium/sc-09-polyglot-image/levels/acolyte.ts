import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// ACOLYTE — the uploader's word. A profile image is accepted when the upload SAYS it is one: its Content-Type, which
// the client writes, names an image type. The bytes are never looked at. The file is stored under the name the
// uploader gave, and the archive server runs a stored file whose name ends in .php when it is fetched.
// (The files live in the lab's simulated file system, and "running" one is the simulated interpreter: nothing real.)
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function store(fs: SimFs, file: UploadedFile): Stored {
  if (!IMAGE_TYPES.has(file.contentType)) return { ok: false, text: 'Only images are accepted (image/png, image/jpeg, image/gif or image/webp).' };
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  return { file, runs: file !== undefined && file.path.endsWith('.php') };
}
