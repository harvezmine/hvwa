// Test builders for the upload engine and the upload labs (core/upload.ts, core/upload-zip.ts).
//
// multipart(): a multipart/form-data body written byte by byte. superagent's .attach() cannot send the names the
// labs teach with (form-data takes the basename of `filename`, so `../x.php` arrives as `x.php`), so specs build the
// body here and send it with .set('Content-Type', m.contentType).send(m.body).
import { Buffer } from 'node:buffer';

/** One part. A string or Buffer `filename` makes it a file part; Buffers are written verbatim (raw header bytes). */
export interface Part {
  readonly name: string | Buffer;
  readonly value?: string | Buffer;
  readonly filename?: string | Buffer;
  readonly contentType?: string;
  /** Extra header lines for the part, written as given. */
  readonly headers?: readonly string[];
}

export interface Multipart {
  readonly body: Buffer;
  readonly contentType: string;
}

const raw = (x: string | Buffer): Buffer => (typeof x === 'string' ? Buffer.from(x, 'utf8') : x);

/** A multipart/form-data body. Names and filenames go between double quotes exactly as given (no escaping). */
export function multipart(parts: readonly Part[], boundary = 'hvwa-test-boundary'): Multipart {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="`), raw(p.name), Buffer.from('"'));
    if (p.filename !== undefined) chunks.push(Buffer.from('; filename="'), raw(p.filename), Buffer.from('"'));
    chunks.push(Buffer.from('\r\n'));
    if (p.contentType !== undefined) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`));
    for (const h of p.headers ?? []) chunks.push(Buffer.from(`${h}\r\n`));
    chunks.push(Buffer.from('\r\n'), raw(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** What parseMultipart reads from an Express request after express.raw(): the headers and the raw Buffer body. */
export function uploadReq(m: Multipart, contentType = m.contentType): { headers: Record<string, string>; body: Buffer } {
  return { headers: { 'content-type': contentType }, body: m.body };
}
