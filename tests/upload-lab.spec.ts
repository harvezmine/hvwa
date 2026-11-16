// An upload lab in miniature (UP-01 "Scroll Desk"), exercising the whole upload recipe through the real app
// (docs/RECIPES.md section 9): express.raw on the upload route only (the app-wide json/urlencoded parsers stay as
// they are), parseMultipart awaited through settle() into tryDb, the file stored in a per-session simFs with the
// level's own name handling, and GET uploads?name=... "running" it with simInterpret when the level maps the name to
// an interpreter. Acolyte runs any .php it stored under the uploader's name; Divine stores under a server-made name
// and never runs anything.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import express, { type Request, type Response } from 'express';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { byLevel, labPath, perSession, tryDb } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { flagFor } from '../src/core/mount.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';
import { simFs, simInterpret, type SimFs } from '../src/core/simfs.js';
import { UPLOADS_IN_FLIGHT, UPLOAD_LIMITS, parseMultipart, settle, uploadGate, uploadsInFlight, type UploadedFile } from '../src/core/upload.js';
import { FLAG_RE, TEST_SECRET, freshSession, serve, type Agent } from './helpers.js';
import { multipart, type Part } from './support/uploads.js';

const view = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upload-desk.ejs');
const LAB = '/d/upload-test/desk';

// --- The fixture lab -------------------------------------------------------------------------------------------

/** The "level files": where a scroll is stored, and which stored names the simulated server hands to an interpreter. */
interface DeskLevel {
  store(fs: SimFs, file: UploadedFile): string;
  runs(path: string): boolean;
}
const impl = byLevel<DeskLevel>({
  acolyte: { // the uploader's own name, and anything ending in .php is "interpreted"
    store: (fs, f) => fs.write(`/srv/uploads/${f.filename}`, f.bytes, { contentType: f.contentType }).path,
    runs: (path) => path.endsWith('.php'),
  },
  divine: { // a server-made name with no user extension, a fixed type, never interpreted
    store: (fs, f) => fs.write(`/srv/uploads/scroll-${randomBytes(6).toString('hex')}.bin`, f.bytes, { contentType: 'application/octet-stream' }).path,
    runs: () => false,
  },
});

const desks = perSession((): { fs: SimFs } => {
  const fs = simFs();
  fs.write('/srv/uploads/README.txt', 'Scrolls go here.', { contentType: 'text/plain', pinned: true });
  return { fs };
});
const deskFor = (req: { sessionId: string; level: Level }) => desks.for(req);

type Result = { ok: boolean; text: string } | null;
const show = (req: Request, res: Response, result: Result) => sendPage(res, view, {
  action: `${labPath(res)}/upload?level=${req.level}`, files: deskFor(req).fs.list('/srv/uploads').map((f) => f.path), result,
});

const DESK = register(defineChallenge({
  id: 'UP-01', district: 'upload-test', slug: 'desk', dir: process.cwd(),
  title: { id: 'Meja gulungan', en: 'Scroll Desk' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: impl.levels, hints: [],
  mount: (router) => {
    router.get('/', (req, res) => show(req, res, null));
    // At most UPLOADS_IN_FLIGHT uploads at once (before the body is read), then the raw multipart body on THIS route
    // only (owner decision Q6), with the engine's body cap.
    router.post('/upload', uploadGate(), express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), async (req, res) => {
      const up = tryDb(req, await settle(parseMultipart(req, { maxFiles: 1 })), 'Upload error'); // async parse, sync rule
      if (!up.ok) return show(req, res, { ok: false, text: up.message });
      const file = up.value.files.find((f) => f.field === 'scroll');
      if (file === undefined) return show(req, res, { ok: false, text: 'Choose a scroll to upload.' });
      const stored = tryDb(req, () => impl.for(req.level).store(deskFor(req).fs, file), 'Storage error');
      return show(req, res, stored.ok ? { ok: true, text: `Stored as ${stored.value}.` } : { ok: false, text: stored.message });
    });
    router.get('/uploads', async (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      const file = deskFor(req).fs.read(`/srv/uploads/${name}`);
      if (file === undefined) { res.status(404); return show(req, res, { ok: false, text: 'No such scroll.' }); }
      if (impl.for(req.level).runs(file.path)) {
        // NOTHING EXECUTES: the simulated interpreter pattern-matches its one statement; the flag only on a match.
        const printed = simInterpret(file.bytes, () => flagFor(req, DESK));
        return show(req, res, { ok: true, text: `The server ran ${file.path}. It printed: ${printed ?? '(nothing)'}` });
      }
      // Never hand uploaded bytes to the player's real browser as an active type, whatever was claimed.
      res.set({
        'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment',
        'Content-Security-Policy': 'sandbox',
      }).send(file.bytes);
    });
  },
}));

// --- Player helpers ---------------------------------------------------------------------------------------------

const upload = (agent: Agent, level: Level, parts: readonly Part[]) => {
  const m = multipart(parts);
  return agent.post(`${LAB}/upload?level=${level}`).set('Content-Type', m.contentType).send(m.body);
};
const scroll = (filename: string | Buffer, value: string | Buffer, contentType = 'application/x-php'): Part => ({ name: 'scroll', filename, value, contentType });
const fetchScroll = (agent: Agent, level: Level, name: string) => agent.get(`${LAB}/uploads?level=${level}&name=${encodeURIComponent(name)}`);

// --- Tests ------------------------------------------------------------------------------------------------------

describe('UP-01: the upload recipe through the real app', () => {
  it('GET / answers at every level with the lab bar and the pinned seed file', async () => {
    const { agent } = await freshSession();
    for (const level of DESK.levels) {
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('Scroll Desk');
      expect(page.text).toContain('data-path="/srv/uploads/README.txt"');
      expect(page.text).toContain(`action="${LAB}/upload?level=${level}"`);
    }
  });

  it('Acolyte: a .php scroll holding the statement is stored under its own name and "runs": the flag, credited at Acolyte', async () => {
    const { agent } = await freshSession();
    const stored = await upload(agent, 'acolyte', [scroll('shell.php', '<?hvwa CANARY ?>'), { name: 'caption', value: 'mine' }]);
    expect(stored.status).toBe(200);
    expect(stored.text).toContain('Stored as /srv/uploads/shell.php.');
    const ran = await fetchScroll(agent, 'acolyte', 'shell.php');
    const flag = ran.text.match(FLAG_RE)?.[0];
    expect(ran.text).toContain('The server ran /srv/uploads/shell.php. It printed: HVWA{');
    expect(flag).toBeDefined();
    const submit = await agent.post('/api/submit').send({ challengeId: DESK.id, submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
    // A .php without the statement runs and prints nothing; a .txt is not run, and is sent as an inert download.
    await upload(agent, 'acolyte', [scroll('quiet.php', '<?php system("id"); ?>')]);
    expect((await fetchScroll(agent, 'acolyte', 'quiet.php')).text).toContain('It printed: (nothing)');
    await upload(agent, 'acolyte', [scroll('page.html', '<script>alert(1)</script><?hvwa CANARY ?>', 'text/html')]);
    const raw = await fetchScroll(agent, 'acolyte', 'page.html');
    expect(raw.headers['content-type']).toBe('application/octet-stream');
    expect([raw.headers['x-content-type-options'], raw.headers['content-disposition'], raw.headers['content-security-policy']]).toEqual(['nosniff', 'attachment', 'sandbox']);
    expect(FLAG_RE.test(raw.body.toString())).toBe(false);
  });

  it('Divine: the same scroll is stored under a server-made name and never runs; no flag anywhere', async () => {
    const { agent } = await freshSession();
    const stored = await upload(agent, 'divine', [scroll('shell.php', '<?hvwa CANARY ?>')]);
    const path = /Stored as (\/srv\/uploads\/scroll-[0-9a-f]{12}\.bin)\./.exec(stored.text)?.[1];
    expect(path).toBeDefined();
    expect((await fetchScroll(agent, 'divine', 'shell.php')).status).toBe(404);
    const served = await fetchScroll(agent, 'divine', (path as string).slice('/srv/uploads/'.length));
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(FLAG_RE.test(served.body.toString()) || FLAG_RE.test(stored.text)).toBe(false);
  });

  it('filenames reach the level exactly as sent: a traversal name lands where the simulated OS resolves it, NUL is kept', async () => {
    const { agent, sid } = await freshSession();
    await upload(agent, 'acolyte', [scroll('../escaped.php', 'x')]);
    await upload(agent, 'acolyte', [scroll(Buffer.from('shell.php\0.jpg', 'latin1'), 'y')]);
    await upload(agent, 'acolyte', [scroll('shell.php%00.jpg', 'z')]);
    expect(deskFor({ sessionId: sid, level: 'acolyte' }).fs.list().map((f) => f.path)).toEqual([
      '/srv/uploads/README.txt', '/srv/escaped.php', '/srv/uploads/shell.php\u0000.jpg', '/srv/uploads/shell.php%00.jpg',
    ]);
    expect(deskFor({ sessionId: sid, level: 'divine' }).fs.size).toBe(1); // levels are isolated
  });

  it('a body over the cap is refused by express.raw itself (413), compressed or not, and nothing is stored', async () => {
    const { agent, sid } = await freshSession();
    const big = multipart([scroll('big.bin', Buffer.alloc(UPLOAD_LIMITS.maxBytes))]);
    const plain = await agent.post(`${LAB}/upload?level=acolyte`).set('Content-Type', big.contentType).send(big.body);
    expect(plain.status).toBe(413);
    // The limit counts the inflated body: a small gzip of a large body is refused the same way.
    const gz = gzipSync(big.body);
    expect(gz.length).toBeLessThan(64 * 1024);
    const zipped = await agent.post(`${LAB}/upload?level=acolyte`).set('Content-Type', big.contentType).set('Content-Encoding', 'gzip').send(gz);
    expect(zipped.status).toBe(413);
    expect(deskFor({ sessionId: sid, level: 'acolyte' }).fs.size).toBe(1);
  });

  it('a request that is not a multipart upload, or a malformed one: the real message below Divine, the generic one at Divine', async () => {
    const { agent } = await freshSession();
    const notMultipart = (level: Level) => agent.post(`${LAB}/upload?level=${level}`).type('form').send({ scroll: 'x' });
    const json = (level: Level) => agent.post(`${LAB}/upload?level=${level}`).send({ scroll: 'x' });
    const malformed = (level: Level) => agent.post(`${LAB}/upload?level=${level}`).set('Content-Type', 'multipart/form-data; boundary=b').send(Buffer.from('--b\r\nnope'));
    for (const send of [notMultipart, json]) {
      expect((await send('acolyte')).text).toContain('Upload error: expected a multipart/form-data request');
    }
    expect((await malformed('acolyte')).text).toContain('Upload error: malformed multipart/form-data body');
    for (const send of [notMultipart, json, malformed]) {
      const r = await send('divine');
      expect(r.status).toBe(200);
      expect(r.text).toContain('Invalid request.');
      expect(r.text).not.toContain('Upload error');
    }
    // A lab cap: this route takes one file.
    expect((await upload(agent, 'acolyte', [scroll('a.php', 'a'), scroll('b.php', 'b')])).text).toContain('Upload error: too many files (at most 1)');
  });

  it('uploadGate: four uploads still streaming hold every slot; a fifth gets 503; hanging up frees the slots', async () => {
    const app = createApp({ flagSecret: TEST_SECRET });
    onTestFinished(() => { app.locals.db.close(); });
    const server = await serve(app);
    const { port } = server.address() as AddressInfo;
    const m = multipart([scroll('slow.php', Buffer.alloc(256 * 1024, 0x61))]);
    // Four clients send their headers and half the body, then stall: each holds a slot while express.raw waits.
    const slow = Array.from({ length: UPLOADS_IN_FLIGHT }, () => {
      const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${LAB}/upload?level=acolyte`,
        headers: { 'content-type': m.contentType, 'content-length': String(m.body.length) } });
      r.on('error', () => {}); // destroyed below
      r.write(m.body.subarray(0, m.body.length / 2));
      return r;
    });
    await vi.waitFor(() => { expect(uploadsInFlight()).toBe(UPLOADS_IN_FLIGHT); });
    const { agent } = await freshSession(app);
    const busy = await upload(agent, 'acolyte', [scroll('fifth.php', 'x')]);
    expect(busy.status).toBe(503);
    expect(busy.text).toBe('Too many uploads in progress (at most 4 at once): try again in a moment.');
    for (const r of slow) r.destroy(); // the clients hang up: their responses close, their slots are freed
    await vi.waitFor(() => { expect(uploadsInFlight()).toBe(0); });
    const ok = await upload(agent, 'acolyte', [scroll('after.php', 'x')]);
    expect([ok.status, ok.text.includes('Stored as /srv/uploads/after.php.')]).toEqual([200, true]);
    expect(uploadsInFlight()).toBe(0); // a finished upload gives its slot back
  });

  it('names and messages are escaped on the page', async () => {
    const { agent } = await freshSession();
    const r = await upload(agent, 'acolyte', [scroll('<img src=x onerror=alert(1)>.txt', 'x')]);
    expect(r.text).not.toContain('<img src=x');
    expect(r.text).toContain('&lt;img src=x onerror=alert(1)&gt;.txt');
  });
});
