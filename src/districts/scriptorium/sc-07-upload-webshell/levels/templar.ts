import type { SimFs } from '../../../../core/simfs.js';
import type { UploadedFile } from '../../../../core/upload.js';
import { UPLOADS_DIR, type Served, type Stored } from '../../_shared/desk.js';

// TEMPLAR — a denylist. Scrolls whose name ends in .php or .phtml, exactly as written, are refused; everything else
// is stored under the uploader's name. The archive server is Windows-like: before it maps a name to an interpreter
// it strips trailing dots and spaces and ignores case, and it runs more than the two spellings the denylist knows.
// A denylist only closes the spellings someone thought of; the file system keeps every name exactly as sent.
const DENIED = ['.php', '.phtml'];

export function store(fs: SimFs, file: UploadedFile): Stored {
  if (DENIED.some((ext) => file.filename.endsWith(ext))) return { ok: false, text: 'Scrolls ending in .php or .phtml are not accepted.' };
  return { ok: true, path: fs.write(`${UPLOADS_DIR}/${file.filename}`, file.bytes, { contentType: file.contentType }).path };
}

const INTERPRETED: ReadonlySet<string> = new Set(['php', 'phtml', 'php5', 'phar']);

/** The extension the server maps: of the name without its trailing dots and spaces, lower-cased. */
function mappedExtension(path: string): string {
  const leaf = path.slice(path.lastIndexOf('/') + 1).replace(/[. ]+$/, '');
  const dot = leaf.lastIndexOf('.');
  return dot < 0 ? '' : leaf.slice(dot + 1).toLowerCase();
}

export function serve(fs: SimFs, name: string): Served {
  const file = fs.read(`${UPLOADS_DIR}/${name}`);
  return { file, runs: file !== undefined && INTERPRETED.has(mappedExtension(file.path)) };
}
