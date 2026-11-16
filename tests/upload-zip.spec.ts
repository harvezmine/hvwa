// core/upload-zip.ts: the hand-rolled ZIP reader SC-10 (ZIP slip) extracts from. End-of-central-directory record,
// central directory, local headers, stored and deflated data; names exactly as written; a zip-bomb guard.
//
// tests/fixtures/upload/python-*.zip were written by Python 3.11's zipfile (the tool a player most likely uses):
// python-slip.zip normally, python-streamed.zip to an unseekable stream (sizes and CRC in data descriptors, flag bit
// 3). Each holds ../../templates/welcome.txt (deflated), notes/ (a directory), notes/readme.txt (stored),
// ..\..\templates\welcome.txt (set on ZipInfo.filename after construction: Python on Windows turns a backslash in
// ZipInfo(name) into '/') and a UTF-8 name with flag bit 11.
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { UploadError } from '../src/core/upload.js';
import { ZIP_LIMITS, readZip, type ZipEntry } from '../src/core/upload-zip.js';
import { zipOf, type ZipItem } from './support/uploads.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/upload/${name}`, import.meta.url));
const names = (entries: readonly ZipEntry[]): string[] => entries.map((e) => e.name);
const zipError = (archive: Buffer, limits = {}): UploadError => {
  try {
    readZip(archive, limits);
  } catch (err) {
    expect(err).toBeInstanceOf(UploadError);
    return err as UploadError;
  }
  throw new Error('readZip did not throw');
};
const one = (item: ZipItem): ZipEntry => {
  const entries = readZip(zipOf([item]));
  expect(entries).toHaveLength(1);
  return entries[0];
};

describe('readZip: entries, names and methods', () => {
  it('reads a real archive (Python zipfile): names, methods, sizes, directories and bytes', () => {
    for (const f of ['python-slip.zip', 'python-streamed.zip']) {
      const entries = readZip(fixture(f));
      expect(entries.map((e) => [e.name, e.method, e.directory, e.size]), f).toEqual([
        ['../../templates/welcome.txt', 'deflate', false, 300],
        ['notes/', 'stored', true, 0],
        ['notes/readme.txt', 'stored', false, 21],
        ['..\\..\\templates\\welcome.txt', 'deflate', false, 12],
        ['ünïcode-✓.txt', 'deflate', false, 11],
      ]);
      expect(entries[0].bytes.toString()).toBe("hvwa('CANARY') ".repeat(20));
      expect(entries[0].compressedSize).toBeLessThan(entries[0].size);
      expect(entries[2].bytes.toString()).toBe('stored, not deflated\n');
      expect(entries[3].bytes.toString()).toBe('backslashes\n');
    }
  });

  it('names come back exactly as written: traversal, backslashes, absolute and drive paths, NUL', () => {
    const tricky = ['../../templates/welcome.txt', '..\\..\\templates\\welcome.txt', '....//....//templates/welcome.txt', '..././x',
      '/srv/app/templates/welcome.txt', 'C:\\Windows\\win.ini', 'a/./b//c', ' spaced .txt', 'shell.php\u0000.jpg', '%2e%2e%2fx'];
    expect(names(readZip(zipOf(tricky.map((name) => ({ name, data: name })))))).toEqual(tricky);
  });

  it('names are decoded as UTF-8 (flag bit 11 or not); an invalid sequence becomes U+FFFD', () => {
    expect(one({ name: 'sigil-é.svg', data: 'x' }).name).toBe('sigil-é.svg');
    expect(one({ name: Buffer.from('caf\u00c3\u00a9.txt', 'latin1'), flags: 0, data: 'x' }).name).toBe('café.txt');
    expect(one({ name: Buffer.from([0x61, 0xff, 0x62]), data: 'x' }).name).toBe('a\uFFFDb');
  });

  it('stored (0) and deflate (8) entries; a directory is a name ending in /', () => {
    const entries = readZip(zipOf([
      { name: 'a.txt', data: 'plain', method: 'stored' },
      { name: 'b.txt', data: 'squeezed '.repeat(50), method: 'deflate' },
      { name: 'dir/', method: 'stored' },
      { name: 'empty.txt', data: '', method: 'deflate' },
    ]));
    expect(entries.map((e) => [e.name, e.method, e.directory, e.bytes.toString()])).toEqual([
      ['a.txt', 'stored', false, 'plain'], ['b.txt', 'deflate', false, 'squeezed '.repeat(50)], ['dir/', 'stored', true, ''], ['empty.txt', 'deflate', false, ''],
    ]);
  });

  it('an empty archive, and one with an archive comment', () => {
    expect(readZip(zipOf([]))).toEqual([]);
    expect(names(readZip(zipOf([{ name: 'a', data: 'b' }], { comment: 'PK\u0005\u0006 looks like a record but is a comment' })))).toEqual(['a']);
  });

  it('nesting: an archive inside an archive is one entry of bytes, never opened', () => {
    const inner = zipOf([{ name: '../../templates/welcome.txt', data: 'inner' }]);
    const entries = readZip(zipOf([{ name: 'inner.zip', data: inner, method: 'stored' }]));
    expect(names(entries)).toEqual(['inner.zip']);
    expect(entries[0].bytes.equals(inner)).toBe(true);
  });

  it('entries are frozen and own their bytes: views of neither the archive nor a larger inflate buffer', () => {
    const archive = zipOf([{ name: 's', data: 'stored bytes', method: 'stored' }, { name: 'd', data: 'deflated bytes' }]);
    const entries = readZip(archive);
    archive.fill(0);
    expect(entries.map((e) => e.bytes.toString())).toEqual(['stored bytes', 'deflated bytes']);
    for (const e of entries) {
      expect(Object.isFrozen(e)).toBe(true);
      expect([e.bytes.byteOffset, e.bytes.buffer.byteLength]).toEqual([0, e.bytes.length]); // measured: zlib answers small inflates with a view of 16 KiB
    }
    expect(Object.isFrozen(entries)).toBe(true);
  });
});

describe('readZip: caps and the zip-bomb guard', () => {
  it('the defaults', () => {
    expect(ZIP_LIMITS).toEqual({ entries: 64, totalBytes: 2 * 1024 * 1024, nameLength: 255 });
    expect(Object.isFrozen(ZIP_LIMITS)).toBe(true);
  });

  it('more than 64 entries (counted from the end record, before anything is read)', () => {
    const items = (n: number): ZipItem[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: '', method: 'stored' }));
    expect(readZip(zipOf(items(64)))).toHaveLength(64);
    expect(zipError(zipOf(items(65))).message).toMatch(/too many entries \(65; at most 64\)/);
    expect(zipError(zipOf(items(3)), { entries: 2 }).message).toMatch(/too many entries/);
  });

  it('declared sizes over the total: refused before anything is inflated', () => {
    const big = { name: 'big', data: 'x', size: ZIP_LIMITS.totalBytes + 1 };
    expect(zipError(zipOf([big])).message).toMatch(/declares .* more than 2097152/);
  });

  it('a bomb that lies about its size: inflation stops at the total and the archive is refused', () => {
    const bomb = deflateRawSync(Buffer.alloc(50 * 1024 * 1024)); // ~50 KB that inflates to 50 MiB
    const t = Date.now();
    expect(zipError(zipOf([{ name: 'bomb.txt', compressed: bomb, size: 10, crc: 0 }])).message).toMatch(/zip bomb/);
    expect(Date.now() - t).toBeLessThan(1000);
    // Within the total, but over what is left of it after the other entries.
    const half = deflateRawSync(Buffer.alloc(ZIP_LIMITS.totalBytes / 2 + 1));
    expect(zipError(zipOf([{ name: 'a', compressed: half, size: 1 }, { name: 'b', compressed: half, size: 1 }])).message).toMatch(/zip bomb/);
  });

  it('overlapping entries (many central records pointing at one deflated blob) still count against the total', () => {
    const blob = Buffer.alloc(600 * 1024, 0x61);
    const first: ZipItem = { name: 'e0', data: blob };
    const archive = zipOf([first, ...Array.from({ length: 4 }, (_, i) => ({ ...first, name: `e${i + 1}`, offset: 0 }))]);
    expect(zipError(archive).message).toMatch(/zip bomb|declares/);
    expect(readZip(zipOf([first, { ...first, name: 'e1', offset: 0 }])).map((e) => e.bytes.length)).toEqual([blob.length, blob.length]);
  });

  it('a lower total a lab passes; a name over nameLength; limits are ceilings', () => {
    expect(zipError(zipOf([{ name: 'a', data: 'x'.repeat(11) }]), { totalBytes: 10 }).message).toMatch(/more than 10/);
    expect(one({ name: 'n'.repeat(255), data: 'x' }).name).toHaveLength(255);
    expect(zipError(zipOf([{ name: 'n'.repeat(256), data: 'x' }])).message).toMatch(/name is longer than 255/);
    expect(() => readZip(zipOf([]), { entries: 65 })).toThrow(/at most 64/);
    expect(() => readZip(zipOf([]), { totalBytes: 0 })).toThrow(/positive integer/);
    expect(() => readZip(zipOf([]), { nope: 1 } as never)).toThrow(/unknown limit "nope"/);
    let err: unknown;
    try { readZip(zipOf([]), { entries: 65 }); } catch (e) { err = e; }
    expect(err).not.toBeInstanceOf(UploadError); // a lab's programming error, not the player's
  });
});

describe('readZip: malformed archives are UploadError, never a crash or a read past the end', () => {
  const good = zipOf([{ name: 'a.txt', data: 'hello hello hello' }, { name: 'b.txt', data: 'world', method: 'stored' }]);

  it('not an archive at all', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(100), Buffer.from('PK\u0003\u0004 truncated', 'latin1')]) {
      expect(zipError(b).message).toMatch(/not a zip archive/);
    }
  });

  it('every truncation of a valid archive is refused with an UploadError', () => {
    for (let n = 0; n < good.length; n++) zipError(good.subarray(0, n));
  });

  it('a broken central directory: bad signature, records past its end, offsets out of range', () => {
    const cases: Record<string, Buffer> = {
      'central signature': zipOf([{ name: 'a', data: 'x' }], { badCentralSignature: true }),
      'more entries than records': zipOf([{ name: 'a', data: 'x' }], { entries: 2 }),
      'directory past the end record': zipOf([{ name: 'a', data: 'x' }], { cdOffset: 10_000 }),
      'directory size past the end record': zipOf([{ name: 'a', data: 'x' }], { cdSize: 10_000 }),
      'local header past the end': zipOf([{ name: 'a', data: 'x', offset: 10_000 }]),
      'local signature': zipOf([{ name: 'a', data: 'x', badLocalSignature: true }]),
      'data past the end': zipOf([{ name: 'a', data: 'x', method: 'stored', compressedSize: 10_000, size: 10_000 }]),
    };
    for (const [what, b] of Object.entries(cases)) expect(zipError(b).message, what).toMatch(/central directory|local header|out of bounds|signature/);
  });

  it('what this reader does not support: ZIP64, multi-volume, encryption, other compression methods', () => {
    expect(zipError(zipOf([{ name: 'a', data: 'x', size: 0xffffffff }])).message).toMatch(/ZIP64/);
    expect(zipError(zipOf([{ name: 'a', data: 'x' }], { cdOffset: 0xffffffff })).message).toMatch(/ZIP64/);
    expect(zipError(zipOf([{ name: 'a', data: 'x' }], { disk: 1 })).message).toMatch(/multi-volume/);
    expect(zipError(zipOf([{ name: 'a', data: 'x' }], { entriesOnDisk: 0, entries: 1 })).message).toMatch(/multi-volume/);
    expect(zipError(zipOf([{ name: 'a', data: 'x', flags: 1 }])).message).toMatch(/encrypted/);
    for (const method of [1, 9, 12, 14, 93, 99]) expect(zipError(zipOf([{ name: 'a', data: 'x', method }])).message).toMatch(new RegExp(`method ${method}`));
  });

  it('data that does not match its header: CRC-32, size, corrupt deflate, a stored entry with two sizes', () => {
    expect(zipError(zipOf([{ name: 'a', data: 'hello', crc: 1234 }])).message).toMatch(/CRC-32/);
    expect(zipError(zipOf([{ name: 'a', data: 'hello', size: 4 }])).message).toMatch(/size/);
    expect(zipError(zipOf([{ name: 'a', compressed: Buffer.from([1, 2, 3, 4, 5]), size: 5 }])).message).toMatch(/corrupt/);
    expect(zipError(zipOf([{ name: 'a', data: 'hello', method: 'stored', size: 3 }])).message).toMatch(/stored entry/);
  });

  it('an entry with an empty name', () => {
    expect(zipError(zipOf([{ name: '', data: 'x' }])).message).toMatch(/empty name/);
  });

  it('error messages name the entry by number, never echo the (attacker-written) name', () => {
    const name = `<script>${'n'.repeat(100)}`;
    const err = zipError(zipOf([{ name: 'ok', data: 'x' }, { name, data: 'hello', crc: 1 }]));
    expect(err.message).toMatch(/entry 2/);
    expect(err.message).not.toContain('<script>');
  });
});
