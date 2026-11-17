import type { SimFs } from '../../../../core/simfs.js';
import { looksLikeImage, type UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// INQUISITOR — a real image check, of the wrong thing. The claimed type is ignored: the server reads the file's own
// header, the PNG, JPEG, GIF or WebP magic bytes and a non-zero width and height (looksLikeImage, as PHP's
// getimagesize() does). A file that starts like an image is stored, every byte of it, under the uploader's name, and
// the archive server runs a stored file whose name ends in .php when it is fetched. A correct header proves the file's
// start, not the whole of it: nothing after the header is ever read.
export function store(fs: SimFs, file: UploadedFile): Stored {
  if (!looksLikeImage(file.bytes)) return { ok: false, text: 'That file is not a real image.' };
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  return { file, runs: file !== undefined && file.path.endsWith('.php') };
}
