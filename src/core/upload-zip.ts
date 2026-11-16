// src/core/upload-zip.ts — a ZIP reader for SC-10 (ZIP slip). Hand-rolled, no dependency: the structure is part of
// the lesson. Read the End Of Central Directory record at the end of the file, walk the central directory it points
// to (one record per entry: name, sizes, CRC-32, method, where its local header is), then each entry's local header
// and data: stored (method 0) is copied, deflate (method 8) goes through node:zlib's inflateRawSync.
//
// Pure: no real filesystem, no network (tests/upload-guard.spec.ts). Entries come back as names and bytes; the lab
// "extracts" them into its simulated filesystem (core/simfs.ts) with its own (flawed) path handling. Names are kept
// EXACTLY as written (`../`, `\`, absolute and drive paths, NUL): that is what ZIP slip is made of.
//
// Bounds (ZIP_LIMITS): at most 64 entries (read from the end record before anything else), names of at most 255
// characters, and a zip-bomb guard: the sizes the central directory declares must add up to at most 2 MiB, and no
// entry may inflate past its declared size (zlib's maxOutputLength stops it there), so the real total is bounded too.
// A nested archive is an entry of bytes, never opened. Not supported (refused): ZIP64, multi-volume, encryption,
// other methods, an end record not at the very end (trailing bytes after the archive comment).
import { Buffer } from 'node:buffer';
import { crc32, inflateRawSync } from 'node:zlib';
import { UploadError, ownBytes } from './upload.js';

export const ZIP_LIMITS = Object.freeze({
  /** Most entries, directories included. */
  entries: 64,
  /** Most bytes all entries declare (and so inflate to), together: the zip-bomb guard. */
  totalBytes: 2 * 1024 * 1024,
  /** Longest entry name, in UTF-16 code units after decoding. */
  nameLength: 255,
});

export type ZipLimits = { readonly [K in keyof typeof ZIP_LIMITS]: number };

export type ZipMethod = 'stored' | 'deflate';

/** One archive entry, in central-directory order. Its bytes are its own copy. */
export interface ZipEntry {
  /** The name exactly as the archive wrote it, decoded as UTF-8 (an invalid sequence becomes U+FFFD; NUL stays U+0000). */
  readonly name: string;
  /** A name ending in `/` (what zip tools write for a folder). */
  readonly directory: boolean;
  readonly method: ZipMethod;
  /** The inflated size (checked against the data). */
  readonly size: number;
  /** The size as stored in the archive. */
  readonly compressedSize: number;
  readonly bytes: Buffer;
}

const EOCD = 0x06054b50; // end of central directory record, 22 bytes + comment
const CENTRAL = 0x02014b50; // central directory file header, 46 bytes + name + extra + comment
const LOCAL = 0x04034b50; // local file header, 30 bytes + name + extra, then the data
const MAX_COMMENT = 0xffff;

function limitsFrom(asked: Partial<ZipLimits>): ZipLimits {
  const out: Record<string, number> = { ...ZIP_LIMITS };
  for (const [key, value] of Object.entries(asked)) {
    if (!Object.hasOwn(ZIP_LIMITS, key)) throw new Error(`readZip: unknown limit "${key}"`);
    const ceiling = ZIP_LIMITS[key as keyof ZipLimits];
    if (!Number.isInteger(value) || value < 1) throw new Error(`readZip: ${key} must be a positive integer (got ${String(value)})`);
    if (value > ceiling) throw new Error(`readZip: ${key} may be at most ${ceiling} (got ${value}); a lab lowers caps, never raises them`);
    out[key] = value;
  }
  return out as ZipLimits;
}

/** The end record: the one whose comment runs exactly to the end of the file (a comment may contain its signature). */
function findEnd(b: Buffer): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - MAX_COMMENT); i--) {
    if (b.readUInt32LE(i) === EOCD && i + 22 + b.readUInt16LE(i + 20) === b.length) return i;
  }
  throw new UploadError('not a zip archive (no end of central directory record at its end)');
}

interface CentralRecord { name: string; flags: number; method: number; crc: number; compressedSize: number; size: number; offset: number }

/**
 * The entries of a ZIP archive, names exactly as written. Throws UploadError for anything that is not a well-formed
 * archive within ZIP_LIMITS (or the lower `limits` a lab passes), a plain Error for limits that are not positive
 * integers or raise a cap (a lab bug). Messages name an entry by its number, never by its (attacker-written) name.
 * Synchronous: call it inside tryDb(req, () => readZip(bytes), 'Archive error').
 */
export function readZip(archive: Uint8Array, limits: Partial<ZipLimits> = {}): readonly ZipEntry[] {
  const lim = limitsFrom(limits);
  const b = Buffer.isBuffer(archive) ? archive : Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEnd(b);
  const disk = b.readUInt16LE(end + 4);
  const cdDisk = b.readUInt16LE(end + 6);
  const onDisk = b.readUInt16LE(end + 8);
  const total = b.readUInt16LE(end + 10);
  const cdSize = b.readUInt32LE(end + 12);
  const cdOffset = b.readUInt32LE(end + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new UploadError('ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new UploadError('multi-volume archives are not supported');
  if (total > lim.entries) throw new UploadError(`too many entries (${total}; at most ${lim.entries})`);
  if (cdOffset + cdSize > end) throw new UploadError('the central directory is out of bounds');

  // The central directory: every record is checked before any data is read.
  const records: CentralRecord[] = [];
  let declared = 0;
  for (let at = cdOffset, n = 1; n <= total; n++) {
    if (at + 46 > cdOffset + cdSize) throw new UploadError(`the central directory is truncated (entry ${n})`);
    if (b.readUInt32LE(at) !== CENTRAL) throw new UploadError(`bad central directory signature (entry ${n})`);
    const flags = b.readUInt16LE(at + 8);
    const method = b.readUInt16LE(at + 10);
    const crc = b.readUInt32LE(at + 16);
    const compressedSize = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLength = b.readUInt16LE(at + 28);
    const recordLength = 46 + nameLength + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    const offset = b.readUInt32LE(at + 42);
    if (at + recordLength > cdOffset + cdSize) throw new UploadError(`the central directory is truncated (entry ${n})`);
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) throw new UploadError('ZIP64 archives are not supported');
    if ((flags & 0x41) !== 0) throw new UploadError(`entry ${n} is encrypted (not supported)`);
    if (method !== 0 && method !== 8) throw new UploadError(`entry ${n} uses compression method ${method} (only 0, stored, and 8, deflate, are supported)`);
    const name = b.toString('utf8', at + 46, at + 46 + nameLength); // a new string: never a view of the archive
    if (name === '') throw new UploadError(`entry ${n} has an empty name`);
    if (name.length > lim.nameLength) throw new UploadError(`entry ${n}'s name is longer than ${lim.nameLength} characters`);
    declared += size;
    records.push({ name, flags, method, crc, compressedSize, size, offset });
    at += recordLength;
  }
  if (declared > lim.totalBytes) {
    throw new UploadError(`the archive declares ${declared} bytes, more than ${lim.totalBytes} (zip bomb guard)`);
  }

  return Object.freeze(records.map((r, i): ZipEntry => {
    const n = i + 1;
    if (r.offset + 30 > cdOffset) throw new UploadError(`entry ${n}'s local header is out of bounds`);
    if (b.readUInt32LE(r.offset) !== LOCAL) throw new UploadError(`bad local header signature (entry ${n})`);
    // The local header's own name and extra lengths (they may differ from the central record's) place the data.
    const start = r.offset + 30 + b.readUInt16LE(r.offset + 26) + b.readUInt16LE(r.offset + 28);
    if (start + r.compressedSize > cdOffset) throw new UploadError(`entry ${n}'s data is out of bounds`);
    const data = b.subarray(start, start + r.compressedSize);
    let bytes: Buffer;
    if (r.method === 0) {
      if (r.compressedSize !== r.size) throw new UploadError(`entry ${n} is a stored entry with two different sizes`);
      bytes = ownBytes(data);
    } else {
      let out: Buffer;
      try {
        // Never more than the entry declares (and the declared sizes fit the total): a lying bomb stops right here.
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, r.size) });
      } catch (err) {
        if (err instanceof RangeError) throw new UploadError(`entry ${n} inflates past its declared size of ${r.size} bytes (zip bomb guard)`);
        throw new UploadError(`entry ${n} has corrupt deflate data`);
      }
      if (out.length !== r.size) throw new UploadError(`entry ${n} inflates to ${out.length} bytes, not its declared size of ${r.size}`);
      bytes = ownBytes(out); // zlib may answer a small inflate with a view of a larger (16 KiB) buffer
    }
    if (crc32(bytes) !== r.crc) throw new UploadError(`entry ${n} fails its CRC-32 check`);
    return Object.freeze({
      name: r.name, directory: r.name.endsWith('/'), method: r.method === 0 ? 'stored' : 'deflate', size: r.size, compressedSize: r.compressedSize, bytes,
    });
  }));
}
