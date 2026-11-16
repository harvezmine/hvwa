// Test builders for the upload engine and the upload labs (core/upload.ts, core/upload-zip.ts).
//
// multipart(): a multipart/form-data body written byte by byte. superagent's .attach() cannot send the names the
// labs teach with (form-data takes the basename of `filename`, so `../x.php` arrives as `x.php`), so specs build the
// body here and send it with .set('Content-Type', m.contentType).send(m.body).
//
// zipOf(): a ZIP archive with any entry names, and headers that can lie (sizes, CRC, offsets, counts), for the
// reader's guards. Real-writer archives are in tests/fixtures/upload/.
import { Buffer } from 'node:buffer';
import { crc32, deflateRawSync } from 'node:zlib';

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

/** One archive entry. The central-directory fields can be overridden to lie. */
export interface ZipItem {
  /** Written as given (a string as UTF-8, a Buffer verbatim). */
  readonly name: string | Buffer;
  readonly data?: string | Buffer;
  /** 'stored' (0), 'deflate' (8, the default) or any method number. */
  readonly method?: 'stored' | 'deflate' | number;
  /** General-purpose flags; default: bit 11 (UTF-8 name) for a string name with non-ASCII characters. */
  readonly flags?: number;
  /** The entry's data as stored in the archive (default: data, deflated for method 8). */
  readonly compressed?: Buffer;
  /** Central-directory lies: declared uncompressed size, compressed size, CRC-32, local header offset. */
  readonly size?: number;
  readonly compressedSize?: number;
  readonly crc?: number;
  readonly offset?: number;
  /** A broken local header signature. */
  readonly badLocalSignature?: boolean;
}

export interface ZipOptions {
  readonly comment?: string;
  /** End-of-central-directory lies. */
  readonly entries?: number;
  readonly entriesOnDisk?: number;
  readonly disk?: number;
  readonly cdSize?: number;
  readonly cdOffset?: number;
  /** A broken central-directory signature on the first record. */
  readonly badCentralSignature?: boolean;
}

/** A ZIP archive: local headers + data, the central directory, the end-of-central-directory record. */
export function zipOf(items: readonly ZipItem[], opts: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  items.forEach((it, i) => {
    const name = raw(it.name);
    const data = raw(it.data ?? '');
    const method = it.method === 'stored' ? 0 : it.method === 'deflate' || it.method === undefined ? 8 : it.method;
    const stored = it.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = it.crc ?? crc32(data);
    const flags = it.flags ?? (typeof it.name === 'string' && /[^\x00-\x7f]/.test(it.name) ? 0x800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(it.badLocalSignature ? 0x04034b51 : 0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(opts.badCentralSignature && i === 0 ? 0x02014b51 : 0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE((it.crc ?? crc) >>> 0, 16);
    cd.writeUInt32LE(it.compressedSize ?? stored.length, 20);
    cd.writeUInt32LE(it.size ?? data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(it.offset ?? offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + stored.length;
  });
  const cd = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? '');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.disk ?? 0, 4);
  eocd.writeUInt16LE(opts.entriesOnDisk ?? opts.entries ?? items.length, 8);
  eocd.writeUInt16LE(opts.entries ?? items.length, 10);
  eocd.writeUInt32LE(opts.cdSize ?? cd.length, 12);
  eocd.writeUInt32LE(opts.cdOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}
