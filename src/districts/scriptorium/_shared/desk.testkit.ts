// src/districts/scriptorium/_shared/desk.testkit.ts — the checks every scroll-desk lab (SC-07, SC-08) repeats: the page, the
// upload route (cap, gate, odd requests), the inert download, how names are shown, isolation and Restart. A test kit
// (docs/RECIPES.md section 1): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { FLAG_RE, TEST_SECRET, freshSession, serve, type Agent } from '../../../../tests/helpers.js';
import { multipart, type Part } from '../../../../tests/support/uploads.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { setPerSessionDefaults } from '../../../core/lab.js';
import { UPLOADS_IN_FLIGHT, UPLOAD_LIMITS, uploadsInFlight } from '../../../core/upload.js';
import type { Challenge } from '../../../core/registry.js';
import { UPLOADS_DIR, type DeskState } from './desk.js';

export interface DeskKit {
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  /** The lab's base path, e.g. '/d/scriptorium/upload-webshell'. */
  readonly path: string;
  readonly heading: string;
  /** The test seam: the lab state of one player at one level. */
  readonly labFor: (req: { sessionId: string; level: Level }) => DeskState;
}

const scroll = (filename: string | Buffer, value: string | Buffer, contentType = 'text/plain'): Part => ({ name: 'scroll', filename, value, contentType });

export function describeDeskBasics(k: DeskKit): void {
  const levels = LEVELS.filter((l) => k.challenge.levels.includes(l));
  const upload = (agent: Agent, level: Level, parts: readonly Part[]) => {
    const m = multipart(parts);
    return agent.post(`${k.path}?level=${level}`).set('Content-Type', m.contentType).send(m.body);
  };
  const listed = (sid: string, level: Level) => k.labFor({ sessionId: sid, level }).fs.list().map((f) => f.path);

  describe(`${k.challenge.id} scroll desk`, () => {
    it('GET / at every level: the lab, the seed scroll, a form with no action, the simulated server\'s one statement, a curl line', async () => {
      const { agent, sid } = await freshSession();
      for (const level of levels) {
        const page = await agent.get(`${k.path}?level=${level}`);
        expect(page.status, level).toBe(200);
        expect(page.text, level).toContain(k.heading);
        expect(page.text, level).toContain('You are signed in as <code>pilgrim</code>');
        expect(page.text, level).toContain(`data-path="${UPLOADS_DIR}/README.txt"`);
        expect(page.text, level).toContain(`href="${k.path}/uploads?level=${level}&amp;name=README.txt"`);
        expect(page.text, level).toMatch(/<form method="post" enctype="multipart\/form-data">/);
        // The page documents the simulated server's single statement and says that nothing really runs.
        expect(page.text, level).toContain('<code>&lt;?hvwa CANARY ?&gt;</code>');
        expect(page.text, level).toContain('nothing you upload ever runs for real');
        // The curl line: multipart with the file name and type spelled out, never the session id.
        expect(page.text, level).toMatch(new RegExp(
          `curl "http://[^/"]+${k.path}\\?level=${level}" -b "hvwa_sid=&lt;copy from devtools&gt;" -F 'scroll=@\\./local-file;filename=&lt;name&gt;;type=&lt;content type&gt;' -F 'caption=&lt;text&gt;'`));
        expect(page.text, level).toContain('<code>curl.exe</code>');
        expect(page.text, level).not.toContain(sid);
      }
    });

    it('the seed scroll is served as an inert download at every level, whatever it is called', async () => {
      const { agent } = await freshSession();
      for (const level of levels) {
        const r = await agent.get(`${k.path}/uploads?level=${level}&name=README.txt`);
        expect(r.status, level).toBe(200);
        expect(r.headers['content-type'], level).toBe('application/octet-stream');
        expect([r.headers['x-content-type-options'], r.headers['content-disposition'], r.headers['content-security-policy']], level)
          .toEqual(['nosniff', 'attachment', 'sandbox']);
        expect(r.body.toString(), level).toBe('Scrolls go here.\n');
      }
    });

    it('a scroll that does not run is never sent to the real browser as an active type; no flag in it', async () => {
      const { agent } = await freshSession();
      await upload(agent, 'acolyte', [scroll('page.html', '<script>alert(1)</script><?hvwa CANARY ?>', 'text/html')]);
      const raw = await agent.get(`${k.path}/uploads?level=acolyte&name=page.html`);
      expect(raw.headers['content-type']).toBe('application/octet-stream');
      expect([raw.headers['x-content-type-options'], raw.headers['content-disposition'], raw.headers['content-security-policy']])
        .toEqual(['nosniff', 'attachment', 'sandbox']);
      expect(FLAG_RE.test(raw.body.toString())).toBe(false);
    });

    it('a request that is not a multipart upload: the real message below Divine, the generic one at Divine; one file at most', async () => {
      const { agent } = await freshSession();
      const notMultipart = (level: Level) => agent.post(`${k.path}?level=${level}`).type('form').send({ scroll: 'x' });
      const json = (level: Level) => agent.post(`${k.path}?level=${level}`).send({ scroll: 'x' });
      const malformed = (level: Level) => agent.post(`${k.path}?level=${level}`).set('Content-Type', 'multipart/form-data; boundary=b').send(Buffer.from('--b\r\nnope'));
      for (const send of [notMultipart, json]) expect((await send('acolyte')).text).toContain('Upload error: expected a multipart/form-data request');
      expect((await malformed('acolyte')).text).toContain('Upload error: malformed multipart/form-data body');
      for (const send of [notMultipart, json, malformed]) {
        const r = await send('divine');
        expect(r.status).toBe(200);
        expect(r.text).toContain('Invalid request.');
        expect(r.text).not.toContain('Upload error');
      }
      expect((await upload(agent, 'acolyte', [scroll('a.txt', 'a'), scroll('b.txt', 'b')])).text).toContain('Upload error: too many files (at most 1)');
      // No file part, or an empty file input (the browser's empty part is dropped): asked to choose one, nothing stored.
      for (const level of levels) {
        expect((await upload(agent, level, [{ name: 'caption', value: 'x' }])).text, level).toContain('Choose a scroll to upload.');
        expect((await upload(agent, level, [scroll('', '')])).text, level).toContain('Choose a scroll to upload.');
      }
    });

    it('a body over the cap gets the lab page at 413 (compressed or not); nothing is stored', async () => {
      const { agent, sid } = await freshSession();
      const big = multipart([scroll('big.bin', Buffer.alloc(UPLOAD_LIMITS.maxBytes))]);
      const r = await agent.post(`${k.path}?level=acolyte`).set('Content-Type', big.contentType).send(big.body);
      expect(r.status).toBe(413);
      expect(r.text).toContain(k.heading);
      expect(r.text).toContain('The scroll is too large (at most 2 MiB).');
      expect(listed(sid, 'acolyte')).toEqual([`${UPLOADS_DIR}/README.txt`]);
    });

    it('the upload route is behind uploadGate: with every slot held by a stalled upload, the next one gets 503; hanging up frees them', async () => {
      const app = createApp({ flagSecret: TEST_SECRET });
      onTestFinished(() => { app.locals.db.close(); });
      const server = await serve(app);
      const { port } = server.address() as AddressInfo;
      const m = multipart([scroll('slow.bin', Buffer.alloc(256 * 1024, 0x61))]);
      const slow = Array.from({ length: UPLOADS_IN_FLIGHT }, () => {
        const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${k.path}?level=acolyte`,
          headers: { 'content-type': m.contentType, 'content-length': String(m.body.length) } });
        r.on('error', () => {});
        r.write(m.body.subarray(0, m.body.length / 2));
        return r;
      });
      await vi.waitFor(() => { expect(uploadsInFlight()).toBe(UPLOADS_IN_FLIGHT); });
      const { agent } = await freshSession(app);
      expect((await upload(agent, 'acolyte', [scroll('fifth.txt', 'x')])).status).toBe(503);
      for (const r of slow) r.destroy();
      await vi.waitFor(() => { expect(uploadsInFlight()).toBe(0); });
      expect((await upload(agent, 'acolyte', [scroll('after.txt', 'x')])).status).toBe(200);
    });

    it('names are shown escaped, control characters as visible escapes, and the link carries the real name', async () => {
      const { agent, sid } = await freshSession();
      const xss = await upload(agent, 'acolyte', [scroll('<img src=x onerror=alert(1)>.txt', 'x')]);
      expect(xss.text).not.toContain('<img src=x');
      expect(xss.text).toContain('&lt;img src=x onerror=alert(1)&gt;.txt');
      const nul = await upload(agent, 'acolyte', [scroll(Buffer.from('a.txt\0.jpg', 'latin1'), 'y')]);
      expect(nul.text).toContain('Stored as /srv/uploads/a.txt\\u0000.jpg.');
      expect(nul.text).toContain('&amp;name=a.txt%00.jpg"');
      expect(listed(sid, 'acolyte')).toContain('/srv/uploads/a.txt\u0000.jpg'); // the file system keeps the NUL
    });

    it('levels and players are isolated: a scroll stored in one lab is not in another', async () => {
      const a = await freshSession();
      const b = await freshSession();
      await upload(a.agent, 'acolyte', [scroll('mine.txt', 'x')]);
      expect(listed(a.sid, 'acolyte')).toContain('/srv/uploads/mine.txt');
      for (const level of levels.filter((l) => l !== 'acolyte')) expect(listed(a.sid, level)).not.toContain('/srv/uploads/mine.txt');
      expect(listed(b.sid, 'acolyte')).not.toContain('/srv/uploads/mine.txt');
      expect((await b.agent.get(`${k.path}/uploads?level=acolyte&name=mine.txt`)).status).toBe(404);
    });

    it('the seed scroll is pinned: it survives more uploads than the file system holds', async () => {
      const { agent, sid } = await freshSession();
      for (let i = 0; i < 40; i++) await upload(agent, 'acolyte', [scroll(`s${i}.txt`, `n${i}`)]);
      const files = listed(sid, 'acolyte');
      expect(files).toContain(`${UPLOADS_DIR}/README.txt`);
      expect(files.length).toBeLessThanOrEqual(32);
    });

    it('the first lab instance of a session is built OUTSIDE tryDb: the 429 of the platform passes through an upload, not a Storage error', async () => {
      setPerSessionDefaults({ maxNewPerMinute: 1 });
      onTestFinished(() => { setPerSessionDefaults({ maxNewPerMinute: Infinity }); });
      const first = await freshSession();
      const second = await freshSession();
      await upload(first.agent, 'acolyte', [scroll('a.txt', 'x')]);
      const r = await upload(second.agent, 'acolyte', [scroll('b.txt', 'x')]);
      expect(r.status).toBe(429);
      expect(r.text).not.toContain('Storage error');
    });

    it('a scroll over the simulated file-system file cap (130 KiB) is refused as an upload, not a storage error', async () => {
      const { agent } = await freshSession();
      const r = await upload(agent, 'acolyte', [scroll('big.bin', Buffer.alloc(130 * 1024, 0x61))]);
      expect(r.text).toContain('Upload error');
      expect(r.text).not.toContain('Storage error');
      expect((await upload(agent, 'divine', [scroll('big.bin', Buffer.alloc(130 * 1024, 0x61))])).text).toContain('Invalid request.');
    });

    it('Restart lab: drops the scrolls (the seed comes back), at the served level only', async () => {
      const { agent, sid } = await freshSession();
      await upload(agent, 'acolyte', [scroll('mine.txt', 'x')]);
      await upload(agent, 'divine', [scroll('mine.txt', 'x')]);
      expect(await agent.post(`${k.path}/_reset?level=acolyte`)).toMatchObject({ status: 303 });
      expect(listed(sid, 'acolyte')).toEqual([`${UPLOADS_DIR}/README.txt`]);
      expect(listed(sid, 'divine').length).toBe(2);
    });
  });
}
