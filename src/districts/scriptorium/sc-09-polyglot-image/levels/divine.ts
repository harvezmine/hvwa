import { randomBytes } from 'node:crypto';
import type { SimFs } from '../../../../core/simfs.js';
import { placeholderImage, sniffImage, type UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// DIVINE — secure reference: transcode, don't validate. The header is read only to learn the image's size; the server
// then stores an image IT made (placeholderImage: a fresh GIF of that size, always 35 bytes, which stands in for
// decoding to pixels and encoding them again; the engine has no image decoder), under a name it made, with a fixed
// type. No byte the player sent is kept, metadata and tails included, so nothing of theirs can run, and nothing is
// ever run anyway: images are data, served as a download or as a raster preview. It never allocates width x height:
// a header may declare 2^31 - 1 on each side. Verbosity: the shell shows "Invalid request." for any error at this
// level. Out of scope: real decoding and re-encoding of pixels, image dimension limits, per-player quotas.
export function store(fs: SimFs, file: UploadedFile): Stored {
  const size = sniffImage(file.bytes);
  if (size === null) return { ok: false, text: 'That file is not a real image.' };
  const path = `${UPLOADS_DIR}/avatar-${randomBytes(6).toString('hex')}.gif`;
  return { ok: true, path: fs.write(path, placeholderImage(size), { contentType: 'image/gif' }).path };
}

export function serve(fs: SimFs, name: string): Served {
  return { file: fs.list(UPLOADS_DIR).find((f) => f.path === `${UPLOADS_DIR}/${name}`), runs: false };
}
