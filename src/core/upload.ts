// src/core/upload.ts — multipart/form-data uploads for the Scriptorium upload labs (SC-05, SC-07 ... SC-11).
//
// Parsed by Node's built-in WHATWG body parser (Response.formData(), undici): no dependency. Pure: no real
// filesystem and no network (tests/upload-guard.spec.ts allows this module node:buffer and core/sim/limits.ts only).
// Uploaded bytes are data, never code: nothing in the engine executes them (owner decision Q7); the labs' "webshell"
// is core/simfs.ts's simInterpret, which pattern-matches one statement.
//
// A lab mounts the raw body parser on its upload route only (owner decision Q6), then awaits the parse:
//   router.post('/upload', express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), async (req, res) => {
//     const up = tryDb(req, await settle(parseMultipart(req)), 'Upload error');
// docs/RECIPES.md section 9 has the whole recipe.
import { Buffer } from 'node:buffer';
import { clip } from './sim/limits.js';

/**
 * A bad upload: not multipart/form-data, a malformed body, or over a cap. core/upload-zip.ts throws it for a bad
 * archive too. Its message is meant for the player below Divine (wrap the parse in tryDb, see settle); an uncaught
 * one answers 400, not 500 (core/errors.ts keeps a 4xx status).
 */
export class UploadError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The caps every parse enforces. A lab may pass lower ones (an SVG lab: maxFileBytes 64 KiB), never higher. */
export const UPLOAD_LIMITS = Object.freeze({
  /** The whole request body, in bytes. The route's express.raw `limit` is the same number (it answers 413 first). */
  maxBytes: 2 * 1024 * 1024,
  /** Parts, text fields and files together. Counted by a scan of the body before it is parsed. */
  maxParts: 32,
  /** File parts (a browser's empty part for an empty file input is dropped and not counted). */
  maxFiles: 8,
  /** One file, in bytes. */
  maxFileBytes: 512 * 1024,
  /** One text field's value, in UTF-8 bytes. */
  maxFieldBytes: 16 * 1024,
  /** A filename or a field name, in UTF-16 code units. Longer ones are refused, never cut (names are the lesson). */
  maxNameLength: 255,
  /** A file part's declared Content-Type. */
  maxContentTypeLength: 255,
});

export type UploadLimits = { readonly [K in keyof typeof UPLOAD_LIMITS]: number };

/** One uploaded file. Every field is the parser's own copy: nothing here keeps the request body alive. */
export interface UploadedFile {
  /** The form field (input name) it came in. */
  readonly field: string;
  /**
   * The filename exactly as the client sent it: `../`, `\`, a leading `/`, dots, spaces, `%00` and every other
   * percent sequence stay as written (the lab decodes or normalizes, or fails to). Only the three escapes browsers
   * write are undone, as the WHATWG parser does: `%0A` LF, `%0D` CR, `%22` `"`. A NUL byte stays U+0000; an invalid
   * UTF-8 sequence becomes U+FFFD (its bytes are not recoverable).
   */
  readonly filename: string;
  /**
   * The declared Content-Type, as the File API reports it: ASCII-lowercased with its parameters (`image/png;
   * charset=utf-8`), `text/plain` when the part had none, `''` when it held a character outside printable ASCII.
   * Client-written: it says what the uploader claims, never what the bytes are.
   */
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface ParsedUpload {
  /**
   * Text fields, null prototype (`__proto__` is an ordinary key); a repeated name keeps its first value. Read them
   * with core/lab field(): `field({ body: up.fields }, 'caption')`.
   */
  readonly fields: Readonly<Record<string, string>>;
  /** File parts, in body order. */
  readonly files: readonly UploadedFile[];
}

/** What parseMultipart reads from a request: an Express request after express.raw() fits. */
export interface UploadRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
}

const MULTIPART = /^[\t ]*multipart\/form-data[\t ]*(;|$)/i;
// The boundary parameter as the WHATWG MIME type parser reads it (first one wins), for the part-count scan only:
// the parse itself is undici's, so a boundary this misreads can only make the scan count less, never refuse more.
const BOUNDARY = /;[\t ]*boundary=(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i;

function limitsFrom(asked: Partial<UploadLimits>): UploadLimits {
  const out: Record<string, number> = { ...UPLOAD_LIMITS };
  for (const [key, value] of Object.entries(asked)) {
    if (!Object.hasOwn(UPLOAD_LIMITS, key)) throw new Error(`parseMultipart: unknown limit "${key}"`);
    const ceiling = UPLOAD_LIMITS[key as keyof UploadLimits];
    if (!Number.isInteger(value) || value < 1) throw new Error(`parseMultipart: ${key} must be a positive integer (got ${String(value)})`);
    if (value > ceiling) throw new Error(`parseMultipart: ${key} may be at most ${ceiling} (got ${value}); a lab lowers caps, never raises them`);
    out[key] = value;
  }
  return out as UploadLimits;
}

/** Delimiter lines in the body (`--boundary` at the start, then each CRLF `--boundary`), counting up to `stop`. */
function delimiters(body: Buffer, boundary: string, stop: number): number {
  const delim = Buffer.from(`\r\n--${boundary}`, 'utf8');
  let n = body.subarray(0, delim.length - 2).equals(delim.subarray(2)) ? 1 : 0;
  for (let at = body.indexOf(delim); at !== -1 && n < stop; at = body.indexOf(delim, at + delim.length)) n++;
  return n;
}

/**
 * Parse an upload request: `req.body` is the raw Buffer express.raw({ type: 'multipart/form-data', limit }) read, and
 * `req.headers['content-type']` names multipart/form-data with its boundary. Parsed with the built-in
 * Response.formData() (no dependency); every cap in UPLOAD_LIMITS (or the lower `limits` given) is enforced, and the
 * part count is checked by a scan of the body before anything is parsed.
 *
 * Throws UploadError (rejects) for a request that is not multipart/form-data, a body that is not a Buffer, a
 * malformed body or a cap; a plain Error for `limits` that are not positive integers or raise a cap (a lab bug).
 * Async: a route awaits it OUTSIDE tryDb, through settle() (tryDb is synchronous).
 */
export async function parseMultipart(req: UploadRequest, limits: Partial<UploadLimits> = {}): Promise<ParsedUpload> {
  const lim = limitsFrom(limits);
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !MULTIPART.test(contentType)) throw new UploadError('expected a multipart/form-data request');
  const body = req.body;
  if (!Buffer.isBuffer(body)) {
    throw new UploadError('no raw request body: an upload route reads it with express.raw({ type: \'multipart/form-data\' })');
  }
  if (body.length > lim.maxBytes) throw new UploadError(`the upload is too large (${body.length} bytes; at most ${lim.maxBytes})`);
  const b = BOUNDARY.exec(contentType);
  const boundary = b === null ? undefined : b[1] !== undefined ? b[1].replace(/\\(.)/g, '$1') : b[2].trim();
  // Each part follows one delimiter and one more closes the body: refuse a flood before undici builds its entries.
  if (boundary && delimiters(body, boundary, lim.maxParts + 2) > lim.maxParts + 1) throw new UploadError(`too many parts (at most ${lim.maxParts})`);

  let form: FormData;
  try {
    // A request body is never over a SharedArrayBuffer; the cast only tells TypeScript so (no copy of the body).
    form = await new Response(body as Buffer<ArrayBuffer>, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new UploadError('malformed multipart/form-data body');
  }

  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const files: UploadedFile[] = [];
  let parts = 0;
  for (const [name, value] of form) {
    if (++parts > lim.maxParts) throw new UploadError(`too many parts (at most ${lim.maxParts})`);
    if (name.length > lim.maxNameLength) throw new UploadError(`a field name is longer than ${lim.maxNameLength} characters`);
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > lim.maxFieldBytes) throw new UploadError(`a text field is too large (at most ${lim.maxFieldBytes} bytes)`);
      if (!Object.hasOwn(fields, name)) fields[clip(name, lim.maxNameLength)] = clip(value, value.length);
      continue;
    }
    if (value.name === '' && value.size === 0) continue; // the empty part a browser sends for an empty file input
    if (files.length >= lim.maxFiles) throw new UploadError(`too many files (at most ${lim.maxFiles})`);
    if (value.size > lim.maxFileBytes) throw new UploadError(`a file is too large (${value.size} bytes; at most ${lim.maxFileBytes})`);
    if (value.name.length > lim.maxNameLength) throw new UploadError(`a filename is longer than ${lim.maxNameLength} characters`);
    if (value.type.length > lim.maxContentTypeLength) {
      throw new UploadError(`a file's content type is longer than ${lim.maxContentTypeLength} characters`);
    }
    files.push(Object.freeze({
      field: clip(name, lim.maxNameLength),
      filename: clip(value.name, lim.maxNameLength),
      contentType: clip(value.type, lim.maxContentTypeLength),
      // arrayBuffer() is a fresh ArrayBuffer of exactly the file's bytes: this Buffer is a view of nothing larger.
      bytes: Buffer.from(await value.arrayBuffer()),
    }));
  }
  return Object.freeze({ fields: Object.freeze(fields), files: Object.freeze(files) });
}

/**
 * A settled promise as a synchronous thunk that returns its value or rethrows its error, so an awaited parse goes
 * through tryDb's error rule (the real message below Divine, a generic one at Divine) like any parser call:
 *
 *   const up = tryDb(req, await settle(parseMultipart(req)), 'Upload error');
 */
export function settle<T>(p: Promise<T>): Promise<() => T> {
  return p.then((value) => () => value, (err: unknown) => () => { throw err; });
}
