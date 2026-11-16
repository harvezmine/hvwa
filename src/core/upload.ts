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
import type { RequestHandler } from 'express';
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

/**
 * A copy of `bytes` in memory of its own: never a view of something larger (a request body, an archive, zlib's
 * output buffer) and never a slice of Node's shared 8 KiB pool (`Buffer.from(x)` of a small x is one), so keeping it
 * keeps only its own bytes alive. Every Buffer the upload engine stores goes through it.
 */
export function ownBytes(bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafeSlow(bytes.length); // unpooled: its own ArrayBuffer of exactly this length
  out.set(bytes);
  return out;
}

/** What parseMultipart reads from a request: an Express request after express.raw() fits. */
export interface UploadRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
}

const MULTIPART = /^[\t ]*multipart\/form-data[\t ]*(;|$)/i;
// The boundary parameter, read strictly for the part-count scan: a plain token or a closed quoted string, ending at
// `;` or the end of the header. The header must hold exactly one `boundary=` (any case), so the scan always looks
// for the boundary undici parses with: `x="; boundary=fake"; boundary=real` cannot steer it to a decoy.
const BOUNDARY = /;[\t ]*boundary=(?:"((?:[^"\\\r\n]|\\.)*)"|([^";\t ]+))[\t ]*(?:;|$)/i;
const BOUNDARY_PARAM = /boundary=/gi;

/** The one boundary of a multipart/form-data content type, or an UploadError (before anything is parsed). */
function boundaryOf(contentType: string): string {
  const bad = (why: string) => new UploadError(`malformed multipart/form-data content type (${why})`);
  if ((contentType.match(BOUNDARY_PARAM) ?? []).length !== 1) throw bad('it needs exactly one boundary parameter');
  const b = BOUNDARY.exec(contentType);
  const boundary = b === null ? '' : b[1] !== undefined ? b[1].replace(/\\(.)/g, '$1') : b[2];
  if (boundary === '') throw bad('the boundary must be a token or a quoted string');
  return boundary;
}

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
  const boundary = boundaryOf(contentType);
  // Each part follows one delimiter and one more closes the body: refuse a flood before undici builds its entries.
  // (The per-entry count below stays as the backstop.)
  if (delimiters(body, boundary, lim.maxParts + 2) > lim.maxParts + 1) throw new UploadError(`too many parts (at most ${lim.maxParts})`);

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

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

/** What a raster image's header says it is. */
export interface ImageSniff {
  readonly type: ImageType;
  readonly mime: `image/${ImageType}`;
  readonly width: number;
  readonly height: number;
}

const startsWith = (b: Uint8Array, at: number, sig: string): boolean => {
  if (at + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig.charCodeAt(i)) return false;
  return true;
};
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const image = (type: ImageType, width: number, height: number): ImageSniff | null =>
  (width > 0 && height > 0 ? Object.freeze({ type, mime: `image/${type}` as const, width, height }) : null);

// JPEG frame headers (SOF0-3, 5-7, 9-11, 13-15): the segment that carries the image's height and width.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sniffJpeg(b: Uint8Array): ImageSniff | null {
  let i = 2; // after SOI (FF D8): a chain of FF-prefixed markers up to the first frame header
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; } // a fill byte
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or the scan data, before any frame header
    const length = be16(b, i + 2); // counts itself, not the marker
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) return length >= 7 && i + 9 <= b.length ? image('jpeg', be16(b, i + 7), be16(b, i + 5)) : null;
    i += 2 + length;
  }
  return null;
}

/**
 * The type and size a raster image's header declares (PNG, JPEG, GIF, WebP), or null. Hand-rolled, no dependency:
 * the magic bytes, then the size fields (PNG's IHDR, GIF's logical screen, JPEG's first frame header after a marker
 * walk, WebP's VP8/VP8L/VP8X chunk); a zero size is not an image.
 *
 * ONLY THE HEADER IS READ, on purpose: whatever follows it is never looked at, so a valid header followed by a script
 * (`GIF89a...<?hvwa CANARY ?>`, a JPEG with `<svg onload=...>` after it) passes. That is SC-09's lesson (a correct
 * header proves the file's start, not the whole of it): use it as the lab's flawed "is it an image?" check, never as
 * a safety check. The safe answer (SC-09 Divine) does not validate; it re-encodes, keeping nothing the player sent.
 */
export function sniffImage(bytes: Uint8Array): ImageSniff | null {
  const b = bytes;
  if (startsWith(b, 0, '\x89PNG\r\n\x1a\n')) {
    // The first chunk must be IHDR (length 13): width and height are 31-bit big-endian.
    if (b.length < 24 || be32(b, 8) !== 13 || !startsWith(b, 12, 'IHDR')) return null;
    const width = be32(b, 16);
    const height = be32(b, 20);
    return width <= 0x7fffffff && height <= 0x7fffffff ? image('png', width, height) : null;
  }
  if (startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a')) return b.length < 10 ? null : image('gif', le16(b, 6), le16(b, 8));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sniffJpeg(b);
  if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) {
    if (startsWith(b, 12, 'VP8 ')) { // lossy: a frame tag, the start code 9D 01 2A, then 14-bit width and height
      return b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? image('webp', le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff) : null;
    }
    if (startsWith(b, 12, 'VP8L')) { // lossless: the signature 2F, then (width - 1) and (height - 1) in 14 bits each
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return image('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (startsWith(b, 12, 'VP8X')) return b.length < 30 ? null : image('webp', le24(b, 24) + 1, le24(b, 27) + 1); // extended: 24-bit sizes - 1
  }
  return null;
}

/** Whether the bytes START like a PNG, JPEG, GIF or WebP image with a non-zero size (see sniffImage: header only). */
export function looksLikeImage(bytes: Uint8Array): boolean {
  return sniffImage(bytes) !== null;
}

/**
 * Most uploads being received or parsed at once, process-wide. Each one holds its body (up to 2 MiB) and the
 * parser's copies while it lasts, so this bounds the transient memory of all upload routes together.
 */
export const UPLOADS_IN_FLIGHT = 4;
let inFlight = 0;
const BUSY = `Too many uploads in progress (at most ${UPLOADS_IN_FLIGHT} at once): try again in a moment.`;

/** Test seam: the uploads holding a slot right now. */
export function uploadsInFlight(): number {
  return inFlight;
}

/**
 * Middleware for an upload route, mounted BEFORE express.raw so a slot is held while the body streams in:
 *
 *   router.post('/upload', uploadGate(), express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), handler)
 *
 * At most UPLOADS_IN_FLIGHT uploads pass at once, across every upload route of every lab. Beyond that it answers
 * 503 (Retry-After: 2, Connection: close) with a plain message, without reading the body. A slot is freed exactly
 * once, when the response finishes or closes (the client hung up) or the request fails.
 */
export function uploadGate(): RequestHandler {
  return (req, res, next) => {
    if (inFlight >= UPLOADS_IN_FLIGHT) {
      res.status(503).set('Retry-After', '2').set('Connection', 'close').type('text/plain').send(BUSY);
      return;
    }
    inFlight++;
    let held = true;
    const release = (): void => {
      if (held) { held = false; inFlight--; }
    };
    res.once('finish', release);
    res.once('close', release);
    req.once('error', release);
    next();
  };
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
