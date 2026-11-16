import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// INQUISITOR — an allowlist, but of the wrong thing. Only images are accepted, and "image" is decided by the
// Content-Type header of the upload, which the client writes. The scroll is then stored under the name it was
// uploaded with, and the archive server maps that name's last extension (any case) to an interpreter. The type the
// uploader claims and the extension the server acts on need not agree.
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif']);

export function store(fs: SimFs, file: UploadedFile): Stored {
  if (!IMAGE_TYPES.has(file.contentType)) return { ok: false, text: 'Only images are accepted (image/jpeg, image/png or image/gif).' };
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

const INTERPRETED: ReadonlySet<string> = new Set(['php', 'phtml', 'php5', 'phar']);

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  if (file === undefined) return { file, runs: false };
  const ext = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase();
  return { file, runs: INTERPRETED.has(ext) };
}
