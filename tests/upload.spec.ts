// core/upload.ts: multipart/form-data uploads over Node's built-in Response.formData() (no dependency), its caps
// and UploadError, and settle() for the Divine error rule.
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { DIVINE_DB_ERROR, field, tryDb } from '../src/core/lab.js';
import { UPLOAD_LIMITS, UploadError, looksLikeImage, parseMultipart, settle, sniffImage, type ParsedUpload } from '../src/core/upload.js';
import { multipart, uploadReq, type Part } from './support/uploads.js';

const parse = (parts: readonly Part[], limits = {}): Promise<ParsedUpload> => parseMultipart(uploadReq(multipart(parts)), limits);
const file = (filename: string | Buffer, value: string | Buffer = 'x', contentType?: string): Part =>
  ({ name: 'scroll', filename, value, contentType });
const nameOf = async (filename: string | Buffer): Promise<string> => (await parse([file(filename)])).files[0].filename;
/** The UploadError a parse rejects with (fails the test if it resolves or rejects with anything else). */
async function uploadError(p: Promise<unknown>): Promise<UploadError> {
  const err: unknown = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(UploadError);
  return err as UploadError;
}

describe('parseMultipart: fields and files', () => {
  it('parses text fields and files: field name, filename, declared content type and the exact bytes', async () => {
    const up = await parse([
      { name: 'caption', value: 'My scroll' },
      { name: 'scroll', filename: 'shell.php', contentType: 'image/jpeg', value: '<?hvwa CANARY ?>' },
    ]);
    expect(up.fields).toEqual({ caption: 'My scroll' });
    expect(up.files).toHaveLength(1);
    const [f] = up.files;
    expect([f.field, f.filename, f.contentType, f.bytes.toString()]).toEqual(['scroll', 'shell.php', 'image/jpeg', '<?hvwa CANARY ?>']);
    expect(Buffer.isBuffer(f.bytes)).toBe(true);
  });

  it('keeps binary bytes exactly: every byte value, CRLF and dashes inside the content', async () => {
    const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\r\n--hvwa-test\r\n--\r\n')]);
    const [f] = (await parse([file('blob.bin', bytes)])).files;
    expect(f.bytes.equals(bytes)).toBe(true);
  });

  it('keeps the files in body order, several under one field name too', async () => {
    const up = await parse([file('a.txt', 'A'), { name: 'other', filename: 'b.txt', value: 'B' }, file('c.txt', 'C')]);
    expect(up.files.map((f) => [f.field, f.filename, f.bytes.toString()])).toEqual([['scroll', 'a.txt', 'A'], ['other', 'b.txt', 'B'], ['scroll', 'c.txt', 'C']]);
  });

  it('a repeated text field keeps its FIRST value', async () => {
    expect((await parse([{ name: 'a', value: '1' }, { name: 'a', value: '2' }])).fields).toEqual({ a: '1' });
  });

  it('fields is a null-prototype record that core/lab field() reads ("__proto__" is an ordinary field)', async () => {
    const up = await parse([{ name: '__proto__', value: 'p' }, { name: 'constructor', value: 'c' }, { name: 'caption', value: 'hi' }]);
    expect(Object.getPrototypeOf(up.fields)).toBeNull();
    expect(Object.keys(up.fields)).toEqual(['__proto__', 'constructor', 'caption']);
    expect(field({ body: up.fields }, 'caption')).toBe('hi');
    expect(field({ body: up.fields }, '__proto__')).toBe('p');
    expect(field({ body: up.fields }, 'missing')).toBe('');
  });

  it('drops the empty part a browser sends for a file input left empty; an empty-named file with content stays', async () => {
    expect((await parse([file('', ''), { name: 'caption', value: 'c' }])).files).toEqual([]);
    const [f] = (await parse([file('', 'content')])).files;
    expect([f.filename, f.bytes.toString()]).toEqual(['', 'content']);
    expect((await parse([file('empty.txt', '')])).files.map((x) => [x.filename, x.bytes.length])).toEqual([['empty.txt', 0]]);
  });

  it('the result is frozen and owns its bytes: changing the request body afterwards changes nothing', async () => {
    const m = multipart([file('a.txt', 'original'), { name: 'caption', value: 'c' }]);
    const up = await parseMultipart(uploadReq(m));
    m.body.fill(0x41);
    expect(up.files[0].bytes.toString()).toBe('original');
    expect(Object.isFrozen(up) && Object.isFrozen(up.fields) && Object.isFrozen(up.files) && Object.isFrozen(up.files[0])).toBe(true);
  });
});

describe('parseMultipart: filenames are kept exactly as sent (the labs teach with them)', () => {
  it('path separators, traversal and absolute names are not stripped', async () => {
    for (const name of ['../../templates/welcome.txt', '..\\..\\templates\\welcome.txt', '/etc/passwd', 'C:\\boot.ini', '....//x', 'a/b\\c']) {
      expect(await nameOf(name), name).toBe(name);
    }
  });

  it('extensions, dots, spaces, case and percent sequences are untouched (the lab decodes, or not)', async () => {
    for (const name of ['shell.php.jpg', 'shell.pHp5', 'shell.php.', 'shell.php ', ' a b ', 'shell.php%00.jpg', 'shell%2ephp', 'a%2fb', 'x;y=z.php', 'a\tb']) {
      expect(await nameOf(name), name).toBe(name);
    }
  });

  it('a NUL byte in a filename is kept as U+0000 (never stripped, never a truncation point)', async () => {
    expect(await nameOf(Buffer.from('shell.php\0.jpg', 'latin1'))).toBe('shell.php\u0000.jpg');
  });

  it('only the three escapes browsers write (%0A, %0D, %22) are undone, as the WHATWG multipart parser does', async () => {
    expect(await nameOf('a%0Ab%0dc%22d%25e%00f')).toBe('a\nb\rc"d%25e%00f');
  });

  it('UTF-8 is decoded; an invalid UTF-8 sequence becomes U+FFFD (the original bytes are not recoverable)', async () => {
    expect(await nameOf('sigil-é✓.png')).toBe('sigil-é✓.png');
    expect(await nameOf(Buffer.from([0x61, 0xff, 0x62, 0xc3, 0x2e, 0x70, 0x6e, 0x67]))).toBe('a\uFFFDb\uFFFD.png');
  });

  it('field names and values follow the same rules (NUL kept, invalid UTF-8 as U+FFFD)', async () => {
    const up = await parse([{ name: Buffer.from('a\0b', 'latin1'), value: Buffer.from([0x76, 0x00, 0xff]) }]);
    expect(up.fields).toEqual({ 'a\u0000b': 'v\u0000\uFFFD' });
  });
});

describe('parseMultipart: the declared content type is kept (as the File API reports it)', () => {
  it('whatever the client claims, whatever the filename says', async () => {
    expect((await parse([file('shell.php', 'x', 'image/jpeg')])).files[0].contentType).toBe('image/jpeg');
    expect((await parse([file('a.gif', 'x', 'application/x-httpd-php')])).files[0].contentType).toBe('application/x-httpd-php');
  });

  it('ASCII-lowercased with its parameters; text/plain when the part has none; empty when it holds non-ASCII', async () => {
    expect((await parse([file('a', 'x', 'Image/PNG; charset=UTF-8')])).files[0].contentType).toBe('image/png; charset=utf-8');
    expect((await parse([file('a', 'x')])).files[0].contentType).toBe('text/plain');
    expect((await parse([file('a', 'x', 'image/gïf')])).files[0].contentType).toBe('');
  });
});

describe('parseMultipart: caps (UPLOAD_LIMITS, or lower ones a lab passes)', () => {
  it('the defaults', () => {
    expect(UPLOAD_LIMITS).toEqual({
      maxBytes: 2 * 1024 * 1024, maxParts: 32, maxFiles: 8, maxFileBytes: 512 * 1024, maxFieldBytes: 16 * 1024,
      maxNameLength: 255, maxContentTypeLength: 255,
    });
    expect(Object.isFrozen(UPLOAD_LIMITS)).toBe(true);
  });

  it('a body over maxBytes', async () => {
    const m = multipart([file('big.bin', Buffer.alloc(UPLOAD_LIMITS.maxBytes))]);
    expect((await uploadError(parseMultipart(uploadReq(m)))).message).toMatch(/too large/);
    expect((await uploadError(parse([file('a', 'x'.repeat(200))], { maxBytes: 100 }))).message).toMatch(/too large/);
  });

  it('more parts than maxParts, files and fields together', async () => {
    const parts = (n: number): Part[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    expect(Object.keys((await parse(parts(32))).fields)).toHaveLength(32);
    expect((await uploadError(parse(parts(33)))).message).toMatch(/too many parts/);
    expect((await uploadError(parse([...parts(2), file('a')], { maxParts: 2 }))).message).toMatch(/too many parts/);
  });

  it('a flood of tiny parts is refused by a scan of the body, before Response.formData() builds thousands of entries', async () => {
    const formData = vi.spyOn(Response.prototype, 'formData');
    try {
      const flood = multipart(Array.from({ length: 25_000 }, () => ({ name: 'a', value: '' })));
      expect(flood.body.length).toBeLessThan(UPLOAD_LIMITS.maxBytes);
      expect((await uploadError(parseMultipart(uploadReq(flood)))).message).toMatch(/too many parts/);
      expect(formData).not.toHaveBeenCalled();
      await parse([{ name: 'a', value: 'b' }]);
      expect(formData).toHaveBeenCalledTimes(1);
    } finally {
      formData.mockRestore();
    }
  });

  it('more files than maxFiles', async () => {
    const files = (n: number): Part[] => Array.from({ length: n }, (_, i) => file(`f${i}.txt`));
    expect((await parse(files(8))).files).toHaveLength(8);
    expect((await uploadError(parse(files(9)))).message).toMatch(/too many files/);
    expect((await uploadError(parse(files(2), { maxFiles: 1 }))).message).toMatch(/too many files/);
  });

  it('a file over maxFileBytes', async () => {
    expect((await parse([file('a.bin', Buffer.alloc(UPLOAD_LIMITS.maxFileBytes))])).files[0].bytes.length).toBe(UPLOAD_LIMITS.maxFileBytes);
    expect((await uploadError(parse([file('a.bin', Buffer.alloc(UPLOAD_LIMITS.maxFileBytes + 1))]))).message).toMatch(/file is too large/);
    expect((await uploadError(parse([file('a.svg', 'x'.repeat(65))], { maxFileBytes: 64 }))).message).toMatch(/file is too large/);
  });

  it('a text field over maxFieldBytes (UTF-8 bytes)', async () => {
    expect((await parse([{ name: 'a', value: 'x'.repeat(16 * 1024) }])).fields.a).toHaveLength(16 * 1024);
    expect((await uploadError(parse([{ name: 'a', value: 'x'.repeat(16 * 1024 + 1) }]))).message).toMatch(/field is too large/);
    expect((await uploadError(parse([{ name: 'a', value: 'é'.repeat(5) }], { maxFieldBytes: 9 }))).message).toMatch(/field is too large/);
  });

  it('a filename or a field name over maxNameLength (UTF-16 code units)', async () => {
    expect(await nameOf('n'.repeat(255))).toHaveLength(255);
    expect((await uploadError(parse([file('n'.repeat(256))]))).message).toMatch(/name is longer than 255/);
    expect((await uploadError(parse([{ name: 'k'.repeat(256), value: 'v' }]))).message).toMatch(/name is longer than 255/);
    expect((await uploadError(parse([{ name: 'k'.repeat(256), filename: 'a', value: 'v' }]))).message).toMatch(/name is longer than 255/);
  });

  it('a declared content type over maxContentTypeLength', async () => {
    expect((await parse([file('a', 'x', `image/${'x'.repeat(249)}`)])).files[0].contentType).toHaveLength(255);
    expect((await uploadError(parse([file('a', 'x', `image/${'x'.repeat(250)}`)]))).message).toMatch(/content type is longer than 255/);
  });

  it('a lab may lower a cap, never raise one, and must pass positive integers', async () => {
    await expect(parse([file('a')], { maxFileBytes: UPLOAD_LIMITS.maxFileBytes + 1 })).rejects.toThrow(/at most 524288/);
    await expect(parse([file('a')], { maxParts: 0 })).rejects.toThrow(/positive integer/);
    await expect(parse([file('a')], { maxFiles: 1.5 })).rejects.toThrow(/positive integer/);
    await expect(parse([file('a')], { nope: 1 } as never)).rejects.toThrow(/unknown limit "nope"/);
    const err = await parse([file('a')], { maxParts: 0 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UploadError); // a lab's programming error, not the player's
  });
});

describe('parseMultipart: malformed or non-multipart requests are UploadError (400), never a 500', () => {
  const good = multipart([{ name: 'a', value: 'v' }, file('b.txt')]);
  const B = 'hvwa-test-boundary';

  it('a malformed body', async () => {
    const bodies: Record<string, Buffer> = {
      truncated: good.body.subarray(0, 40),
      'no closing delimiter': Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n`),
      'unquoted name': Buffer.from(`--${B}\r\nContent-Disposition: form-data; name=a\r\n\r\nv\r\n--${B}--\r\n`),
      'no Content-Disposition': Buffer.from(`--${B}\r\nContent-Type: text/plain\r\n\r\nv\r\n--${B}--\r\n`),
      'a filename*= parameter': Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"; filename*=UTF-8''x\r\n\r\nv\r\n--${B}--\r\n`),
      'a preamble': Buffer.concat([Buffer.from('junk\r\n'), good.body]),
      empty: Buffer.alloc(0),
      garbage: Buffer.from('hello'),
    };
    for (const [what, body] of Object.entries(bodies)) {
      const err = await uploadError(parseMultipart({ headers: { 'content-type': good.contentType }, body }));
      expect(err.message, what).toBe('malformed multipart/form-data body');
      expect(err.status).toBe(400);
    }
  });

  it('a boundary that is missing, wrong or over 70 characters', async () => {
    for (const ct of ['multipart/form-data', 'multipart/form-data; boundary=nope', `multipart/form-data; boundary=${'x'.repeat(71)}`]) {
      expect((await uploadError(parseMultipart(uploadReq(good, ct)))).message, ct).toMatch(/malformed|boundary/);
    }
  });

  it('a request that is not multipart/form-data, even when its body parses as a form', async () => {
    const cases: Array<{ headers: Record<string, string>; body?: unknown }> = [
      { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('a=1') },
      { headers: { 'content-type': 'multipart/mixed; boundary=hvwa-test-boundary' }, body: good.body },
      { headers: { 'content-type': 'text/plain' }, body: good.body },
      { headers: {}, body: good.body },
    ];
    for (const req of cases) expect((await uploadError(parseMultipart(req))).message).toMatch(/expected a multipart\/form-data request/);
  });

  it('a body the route did not read raw (no express.raw, or a parser already turned it into an object)', async () => {
    for (const body of [undefined, {}, { a: '1' }, 'a string', [1]]) {
      expect((await uploadError(parseMultipart({ headers: { 'content-type': good.contentType }, body }))).message).toMatch(/express\.raw/);
    }
  });

  it('the media type is matched case-insensitively, with a quoted boundary too', async () => {
    expect((await parseMultipart(uploadReq(good, `Multipart/Form-Data; boundary="${B}"`))).fields).toEqual({ a: 'v' });
  });
});

describe('settle: an awaited parse goes through tryDb, so Divine shows the generic error', () => {
  it('a value comes back through the thunk; an error is rethrown by it', async () => {
    expect((await settle(Promise.resolve(42)))()).toBe(42);
    const thunk = await settle(Promise.reject(new UploadError('nope')));
    expect(thunk).toThrow('nope');
  });

  it('with tryDb: the real message below Divine, the generic one at Divine', async () => {
    const bad = { headers: { 'content-type': 'text/plain' }, body: Buffer.from('x') };
    expect(tryDb({ level: 'acolyte' }, await settle(parseMultipart(bad)), 'Upload error'))
      .toEqual({ ok: false, message: 'Upload error: expected a multipart/form-data request' });
    expect(tryDb({ level: 'divine' }, await settle(parseMultipart(bad)), 'Upload error')).toEqual({ ok: false, message: DIVINE_DB_ERROR });
    const ok = tryDb({ level: 'divine' }, await settle(parse([{ name: 'a', value: 'b' }])), 'Upload error');
    expect(ok.ok && ok.value.fields).toEqual({ a: 'b' });
  });
});

describe('memory: what a parse returns does not keep the request body alive', () => {
  it('a small file, its name and a caption kept from many large bodies retain only their own bytes', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
    // Each body: a near-cap file nobody keeps, then the small file and the caption a lab would keep.
    const body = (i: number) => uploadReq(multipart([
      file(`big-${i}.bin`, Buffer.alloc(UPLOAD_LIMITS.maxFileBytes - 1024, 0x61 + (i % 26))),
      file(`small-${i}.php`, `<?hvwa CANARY ?> ${i}`),
      { name: 'caption', value: `caption-${i}` },
    ]));
    for (let i = 0; i < 3; i++) await parseMultipart(body(i)); // warm-up: the parser's own first-use allocations
    gc(); gc();
    const before = process.memoryUsage();
    const kept: Array<{ caption: string; bytes: Buffer; name: string }> = [];
    for (let i = 0; i < 40; i++) {
      const up = await parseMultipart(body(i));
      kept.push({ caption: up.fields.caption, bytes: up.files[1].bytes, name: up.files[1].filename });
    }
    gc(); gc();
    const after = process.memoryUsage();
    const retained = (after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers);
    // As views of their bodies (or of the parser's blobs): 40 x ~0.5 MiB = 20 MiB. As their own bytes: a few KB.
    expect(retained).toBeLessThan(4 * 1024 * 1024);
    expect(kept[39]).toEqual({ caption: 'caption-39', bytes: Buffer.from('<?hvwa CANARY ?> 39'), name: 'small-39.php' });
  });
});

// --- looksLikeImage / sniffImage ----------------------------------------------------------------------------------

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const bytes = (...parts: Array<number[] | string>): Buffer =>
  Buffer.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));

/** Minimal real headers: every byte the sniff needs. */
const IMG = {
  png: (w: number, h: number) => bytes([0x89], 'PNG\r\n\x1a\n', u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0]),
  gif: (w: number, h: number, v = '89a') => bytes(`GIF${v}`, u16le(w), u16le(h), [0xf7, 0, 0]),
  // SOI, an APP0 (JFIF) segment, then a frame header (SOF0 baseline by default): precision, height, width.
  jpeg: (w: number, h: number, sof = 0xc0) => bytes([0xff, 0xd8, 0xff, 0xe0], u16be(16), 'JFIF\0', [1, 1, 0], u16be(1), u16be(1), [0, 0],
    [0xff, sof], u16be(17), [8], u16be(h), u16be(w), [3]),
  webpVp8: (w: number, h: number) => bytes('RIFF', u32le(30), 'WEBPVP8 ', u32le(10), [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a], u16le(w), u16le(h)),
  webpVp8l: (w: number, h: number) => bytes('RIFF', u32le(30), 'WEBPVP8L', u32le(5), [0x2f], u32le(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14))),
  webpVp8x: (w: number, h: number) => bytes('RIFF', u32le(30), 'WEBPVP8X', u32le(10), [0, 0, 0, 0], u24le(w - 1), u24le(h - 1)),
};
const shortestAccepted = (img: Buffer): number | undefined => [...Array(img.length + 1).keys()].find((n) => looksLikeImage(img.subarray(0, n)));

describe('looksLikeImage / sniffImage: magic bytes and dimensions from the header', () => {
  it('PNG, GIF87a/89a, JPEG (baseline and progressive), WebP (VP8, VP8L, VP8X): type, MIME type and size', () => {
    expect(sniffImage(IMG.png(640, 480))).toEqual({ type: 'png', mime: 'image/png', width: 640, height: 480 });
    expect(sniffImage(IMG.gif(1, 2, '87a'))).toEqual({ type: 'gif', mime: 'image/gif', width: 1, height: 2 });
    expect(sniffImage(IMG.gif(300, 65535))).toEqual({ type: 'gif', mime: 'image/gif', width: 300, height: 65535 });
    expect(sniffImage(IMG.jpeg(1024, 768))).toEqual({ type: 'jpeg', mime: 'image/jpeg', width: 1024, height: 768 });
    expect(sniffImage(IMG.jpeg(16, 9, 0xc2))).toEqual({ type: 'jpeg', mime: 'image/jpeg', width: 16, height: 9 });
    expect(sniffImage(IMG.webpVp8(320, 200))).toEqual({ type: 'webp', mime: 'image/webp', width: 320, height: 200 });
    expect(sniffImage(IMG.webpVp8l(5000, 7))).toEqual({ type: 'webp', mime: 'image/webp', width: 5000, height: 7 });
    expect(sniffImage(IMG.webpVp8x(70000, 3))).toEqual({ type: 'webp', mime: 'image/webp', width: 70000, height: 3 });
    for (const img of [IMG.png(1, 1), IMG.gif(1, 1), IMG.jpeg(1, 1), IMG.webpVp8(1, 1), IMG.webpVp8l(1, 1), IMG.webpVp8x(1, 1)]) {
      expect(looksLikeImage(img)).toBe(true);
      expect(looksLikeImage(new Uint8Array(img))).toBe(true); // any Uint8Array, not only a Buffer
    }
  });

  it('JPEG: fill bytes and standalone markers before the frame header are skipped', () => {
    const j = IMG.jpeg(8, 8);
    const filled = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff, 0xd0, 0xff, 0x01]), j.subarray(2)]);
    expect(sniffImage(filled)).toEqual({ type: 'jpeg', mime: 'image/jpeg', width: 8, height: 8 });
  });

  it('not an image: text, markup, a script, other formats, an empty file', () => {
    const not = ['', 'hello', '<?hvwa CANARY ?>', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>', '<?xml version="1.0"?><svg/>',
      '%PDF-1.7', 'BM6\0\0\0', 'GIF90a\x01\0\x01\0', 'RIFF\0\0\0\0WAVEfmt ', '\x89PNX\r\n\x1a\n'];
    for (const s of not) expect(looksLikeImage(Buffer.from(s, 'latin1')), JSON.stringify(s)).toBe(false);
  });

  it('a right signature with a broken or zero-size header is not an image', () => {
    const bad: Record<string, Buffer> = {
      'PNG without IHDR first': bytes([0x89], 'PNG\r\n\x1a\n', u32be(13), 'tEXt', u32be(1), u32be(1)),
      'PNG 0 wide': IMG.png(0, 5),
      'PNG over 2^31-1 high': IMG.png(5, 0x80000000),
      'GIF 0 high': IMG.gif(5, 0),
      'JPEG 0 wide': IMG.jpeg(0, 5),
      'JPEG: start of scan before any frame header': bytes([0xff, 0xd8, 0xff, 0xda], u16be(8), [1, 1, 0, 0, 0, 0]),
      'JPEG: end of image first': bytes([0xff, 0xd8, 0xff, 0xd9]),
      'JPEG: a segment length under 2': bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0]),
      'JPEG: no marker where one belongs': bytes([0xff, 0xd8, 0x00, 0xe0, 0, 4, 0, 0]),
      'WebP VP8 without its start code': bytes('RIFF', u32le(30), 'WEBPVP8 ', u32le(10), [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2b], u16le(4), u16le(4)),
      'WebP VP8 0 wide': IMG.webpVp8(0, 4),
      'WebP VP8L without its signature byte': bytes('RIFF', u32le(30), 'WEBPVP8L', u32le(5), [0x2e], u32le(0)),
      'WebP with an unknown first chunk': bytes('RIFF', u32le(30), 'WEBPVP9 ', u32le(10), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    for (const [what, b] of Object.entries(bad)) expect(looksLikeImage(b), what).toBe(false);
  });

  it('every truncation of a valid header is not an image (bounds are checked, nothing reads past the end)', () => {
    const makers = [IMG.png, IMG.gif, IMG.jpeg, IMG.webpVp8, IMG.webpVp8l, IMG.webpVp8x];
    for (const make of makers) {
      const img = make(9, 9);
      const need = shortestAccepted(img);
      expect(need).toBeDefined();
      for (let n = 0; n < (need as number); n++) expect(sniffImage(img.subarray(0, n))).toBeNull();
    }
    // The shortest prefix each format is accepted with: just the bytes up to its size fields.
    expect(makers.map((make) => shortestAccepted(make(9, 9)))).toEqual([24, 10, 29, 30, 25, 30]);
  });

  it("SC-09's lesson: only the header is checked, so a valid header followed by a script passes (a polyglot)", () => {
    const tail = '\n<?hvwa CANARY ?>\n<svg onload="hvwa(1)"/>';
    for (const head of [IMG.gif(1, 1), IMG.jpeg(1, 1), IMG.png(1, 1), IMG.webpVp8x(1, 1)]) {
      expect(looksLikeImage(Buffer.concat([head, Buffer.from(tail)]))).toBe(true);
    }
    expect(looksLikeImage(Buffer.from(tail))).toBe(false);
    // The bytes after the header are never looked at: a megabyte of anything changes nothing.
    expect(sniffImage(Buffer.concat([IMG.gif(2, 3), Buffer.alloc(1024 * 1024, 0x3c)]))).toEqual({ type: 'gif', mime: 'image/gif', width: 2, height: 3 });
  });
});
