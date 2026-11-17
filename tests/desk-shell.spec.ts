// The Scroll Desk shell's options (src/districts/scriptorium/_shared/desk.ts), on a fixture lab DK-01:
// newDesk({ seed, separators }), the lab's own view partial with extra(req, res) data, the statementNote toggle, and
// the raster-only preview route (the type its header says, nosniff, CSP sandbox, a fixed CSS box, and at Divine only
// placeholderImage). The defaults (SC-07, SC-08) are covered by describeDeskBasics in their own specs.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { byLevel, labPath, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { placeholderImage, sniffImage } from '../src/core/upload.js';
import { UPLOADS_DIR, mountDesk, newDesk, type DeskLevel, type DeskState } from '../src/districts/scriptorium/_shared/desk.js';
import { FLAG_RE, freshSession, type Agent } from './helpers.js';
import { multipart, type Part } from './support/uploads.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LAB = '/d/desk-test/desk';
const SEED = placeholderImage({ width: 3, height: 2 });

// The "level files". The fixture's Divine keeps the player's bytes ON PURPOSE (a real Divine stores only what the server
// made), so the preview's own Divine rule (never a byte the player wrote) is visible on its own.
const keep: DeskLevel = {
  store: (fs, f) => ({ ok: true, path: fs.write(`${UPLOADS_DIR}/${f.filename}`, f.bytes, { contentType: f.contentType }).path }),
  serve: (fs, name) => ({ file: fs.read(`${UPLOADS_DIR}/${name}`), runs: false }),
};
const impl = byLevel<DeskLevel>({ acolyte: keep, divine: keep });
const desks = perSession((): DeskState => newDesk({ seed: { name: 'sample.gif', bytes: SEED, contentType: 'image/gif' }, separators: '/\\' }));
const labFor = (req: { sessionId: string; level: Level }): DeskState => desks.for(req);

const DK = register(defineChallenge({
  id: 'DK-01', district: 'desk-test', slug: 'desk', dir: process.cwd(),
  title: { id: 'Meja', en: 'Desk' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: impl.levels, hints: [],
  mount: (router) => {
    mountDesk(router, {
      challenge: () => DK, levels: impl, labFor, heading: 'Fixture Desk', blurb: 'A fixture.',
      partial: join(fixtures, 'desk-extra.ejs'),
      extra: (req, res) => ({ level: req.level, base: labPath(res), tricky: '<b>x</b>' }),
      statementNote: false,
      preview: true,
    });
  },
}));

const upload = (agent: Agent, level: Level, parts: readonly Part[]) => {
  const m = multipart(parts);
  return agent.post(`${LAB}?level=${level}`).set('Content-Type', m.contentType).send(m.body);
};
const scroll = (filename: string, value: string | Buffer, contentType: string): Part => ({ name: 'scroll', filename, value, contentType });
const preview = (agent: Agent, level: Level, name: string) => agent.get(`${LAB}/preview?level=${level}&name=${encodeURIComponent(name)}`);
const box = (level: Level, name: string) =>
  `<img class="desk-preview" src="${LAB}/preview?level=${level}&amp;name=${encodeURIComponent(name)}" alt="" width="128" height="128" style="width: 8rem; height: 8rem; object-fit: contain">`;

/** A GIF header (6x4) followed by markup and the simulated server's statement: a polyglot. */
const POLYGLOT = Buffer.concat([Buffer.from('GIF89a\x06\x00\x04\x00\x80\x00\x00', 'latin1'), Buffer.from('<script>alert(1)</script><svg onload=alert(1)><?hvwa CANARY ?>')]);
/** A PNG whose IHDR declares 2^31 - 1 on each side: never allocate pixels from a sniffed size. */
const HUGE_PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(0x7fffffff, 16);
  b.writeUInt32BE(0x7fffffff, 20);
  return b;
})();

describe('Scroll Desk: newDesk({ seed, separators })', () => {
  it('newDesk() keeps its default: README.txt, pinned, text/plain, POSIX separators', () => {
    const plain = perSession((): DeskState => newDesk());
    const { fs } = plain.for({ sessionId: 'desk-shell-default', level: 'acolyte' });
    const readme = fs.read(`${UPLOADS_DIR}/README.txt`);
    expect([readme?.bytes.toString(), readme?.contentType, readme?.pinned]).toEqual(['Scrolls go here.\n', 'text/plain', true]);
    expect(fs.separators).toBe('/');
    expect(fs.size).toBe(1);
  });

  it('a seed of the lab\'s own: pinned under /srv/uploads with its type, the only file; separators reach the file system', async () => {
    const { sid } = await freshSession();
    const { fs } = labFor({ sessionId: sid, level: 'acolyte' });
    const seed = fs.read(`${UPLOADS_DIR}/sample.gif`);
    expect([seed?.contentType, seed?.pinned, seed?.bytes.equals(SEED)]).toEqual(['image/gif', true, true]);
    expect(fs.list().map((f) => f.path)).toEqual([`${UPLOADS_DIR}/sample.gif`]);
    expect(fs.separators).toBe('/\\');
    expect(fs.resolve(`${UPLOADS_DIR}\\x.txt`)).toBe(`${UPLOADS_DIR}/x.txt`);
  });
});

describe('Scroll Desk: the lab\'s partial, extra(req, res) and statementNote', () => {
  it('the page includes the partial with its extra data (escaped) next to the desk\'s own; no statement note when it is off', async () => {
    const { agent } = await freshSession();
    for (const level of ['acolyte', 'divine'] as const) {
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain(`<p class="lab-note" data-testid="desk-extra">Extra for ${level} at ${LAB}: &lt;b&gt;x&lt;/b&gt; (heading still Fixture Desk)</p>`);
      expect(page.text).not.toContain('<b>x</b>');
      expect(page.text).not.toContain('data-testid="statement-note"');
      expect(page.text).not.toContain('&lt;?hvwa CANARY ?&gt;');
    }
  });

  it('the partial is drawn after an upload too, and under the message', async () => {
    const { agent } = await freshSession();
    const r = await upload(agent, 'acolyte', [scroll('a.txt', 'x', 'text/plain')]);
    const message = r.text.indexOf('data-testid="lab-message"');
    const extra = r.text.indexOf('data-testid="desk-extra"');
    expect(message).toBeGreaterThan(0);
    expect(extra).toBeGreaterThan(message);
  });

  it('mountDesk refuses a partial that is not an absolute .ejs path (a lab bug)', () => {
    const base = { challenge: () => DK, levels: impl, labFor, heading: 'x', blurb: 'x' };
    const router = { get: () => router, post: () => router } as unknown as Parameters<typeof mountDesk>[0];
    expect(() => mountDesk(router, { ...base, partial: 'views/x.ejs' })).toThrow(/absolute \.ejs/);
    expect(() => mountDesk(router, { ...base, partial: join(fixtures, 'desk-extra.html') })).toThrow(/absolute \.ejs/);
  });
});

describe('Scroll Desk: the raster-only preview route', () => {
  it('a raster file is shown in a fixed CSS box; a file that is not a raster gets no image', async () => {
    const { agent } = await freshSession();
    await upload(agent, 'acolyte', [scroll('notes.txt', 'plain words', 'text/plain')]);
    const page = (await agent.get(`${LAB}?level=acolyte`)).text;
    expect(page).toContain(box('acolyte', 'sample.gif'));
    const notes = /<li data-path="\/srv\/uploads\/notes\.txt">[\s\S]*?<\/li>/.exec(page)?.[0] ?? '';
    expect(notes).toContain('notes.txt');
    expect(notes).not.toContain('desk-preview');
  });

  it('serves a raster as the type its header says, never the claim: nosniff, CSP sandbox; below Divine the stored bytes', async () => {
    const { agent } = await freshSession();
    await upload(agent, 'acolyte', [scroll('poly.html', POLYGLOT, 'text/html')]);
    const gif = placeholderImage({ width: 1, height: 1 });
    const png = Buffer.concat([HUGE_PNG.subarray(0, 16), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7])]); // a 5x7 PNG header
    await upload(agent, 'acolyte', [scroll('claims-gif.png', png, 'image/gif')]);
    await upload(agent, 'acolyte', [scroll('claims-png.gif', gif, 'image/png')]);
    const poly = await preview(agent, 'acolyte', 'poly.html');
    expect(poly.status).toBe(200);
    expect(poly.headers['content-type']).toBe('image/gif');
    expect([poly.headers['x-content-type-options'], poly.headers['content-security-policy']]).toEqual(['nosniff', 'sandbox']);
    expect((poly.body as Buffer).equals(POLYGLOT)).toBe(true);
    expect((await preview(agent, 'acolyte', 'claims-gif.png')).headers['content-type']).toBe('image/png');
    expect((await preview(agent, 'acolyte', 'claims-png.gif')).headers['content-type']).toBe('image/gif');
  });

  it('raster-only: a text file, an SVG and a missing name are a plain-text 404 that carries none of the file', async () => {
    const { agent } = await freshSession();
    await upload(agent, 'acolyte', [scroll('s.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'image/svg+xml')]);
    await upload(agent, 'acolyte', [scroll('n.txt', 'secret words', 'image/gif')]);
    for (const name of ['s.svg', 'n.txt', 'missing.gif', '']) {
      const r = await preview(agent, 'acolyte', name);
      expect(r.status, name).toBe(404);
      expect(r.headers['content-type'], name).toBe('text/plain; charset=utf-8');
      expect([r.headers['x-content-type-options'], r.headers['content-security-policy']], name).toEqual(['nosniff', 'sandbox']);
      expect(r.text, name).toBe('No such image.');
    }
  });

  it('at Divine never a byte the player wrote: placeholderImage of the sniffed size, 35 bytes, whatever the size declared', async () => {
    const { agent } = await freshSession();
    await upload(agent, 'divine', [scroll('poly.gif', POLYGLOT, 'image/gif')]);
    await upload(agent, 'divine', [scroll('huge.png', HUGE_PNG, 'image/png')]);
    const poly = await preview(agent, 'divine', 'poly.gif');
    expect(poly.headers['content-type']).toBe('image/gif');
    expect((poly.body as Buffer).equals(placeholderImage({ width: 6, height: 4 }))).toBe(true);
    const huge = await preview(agent, 'divine', 'huge.png');
    expect(huge.headers['content-type']).toBe('image/png'); // the type its header says; the bytes are the server's GIF
    expect((huge.body as Buffer).length).toBe(35);
    expect(sniffImage(huge.body as Buffer)).toMatchObject({ type: 'gif', width: 65535, height: 65535 });
    expect(FLAG_RE.test((poly.body as Buffer).toString('latin1'))).toBe(false);
    expect((poly.body as Buffer).toString('latin1')).not.toContain('<svg');
  });

  it('/uploads stays the inert download, for a raster too', async () => {
    const { agent } = await freshSession();
    const r = await agent.get(`${LAB}/uploads?level=acolyte&name=sample.gif`);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect([r.headers['x-content-type-options'], r.headers['content-disposition'], r.headers['content-security-policy']]).toEqual(['nosniff', 'attachment', 'sandbox']);
    expect((r.body as Buffer).equals(SEED)).toBe(true);
  });
});
