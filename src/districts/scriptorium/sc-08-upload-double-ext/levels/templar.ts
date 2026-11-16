import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// TEMPLAR — the check and the server read the name differently. The upload check allows only images, judged by the
// LAST extension of the name (everything after the last dot); the archive server maps the FIRST extension (what
// follows the first dot) to an interpreter. A name can have more than one extension, and the first dot and the last
// dot do not mean the same thing to different code.
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'gif']);

export function store(fs: SimFs, file: UploadedFile): Stored {
  const last = file.filename.slice(file.filename.lastIndexOf('.') + 1).toLowerCase();
  if (!file.filename.includes('.') || !IMAGE_EXTENSIONS.has(last)) return { ok: false, text: 'Only .jpg, .jpeg, .png and .gif scrolls are accepted.' };
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  if (file === undefined) return { file, runs: false };
  const leaf = file.path.slice(file.path.lastIndexOf('/') + 1);
  const first = leaf.split('.')[1]?.toLowerCase(); // the first extension
  return { file, runs: first === 'php' };
}
