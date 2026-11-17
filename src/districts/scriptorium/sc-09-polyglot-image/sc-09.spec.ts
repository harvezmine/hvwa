// src/districts/scriptorium/sc-09-polyglot-image/sc-09.spec.ts — SC-09 Upload polyglot image (levels A/I/D).
// The profile-image desk stores only "real images", and the archive server runs a stored .php when it is fetched (the
// simulated interpreter: it prints the flag for the one statement <?hvwa CANARY ?>, nothing ever executes). Acolyte
// believes the uploader's Content-Type; Inquisitor reads the file's own header (looksLikeImage), which a polyglot
// passes; Divine transcodes: it keeps only a placeholder image the server made (placeholderImage, constant size).
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, freshSession, describeExploitMatrix, describeLabView, type Agent,
} from '../../../../tests/helpers.js';
import { multipart, type Part } from '../../../../tests/support/uploads.js';
import type { Level } from '../../../core/levels.js';
import { placeholderImage, sniffImage } from '../../../core/upload.js';
import { xssOracle } from '../../../core/xss.js';
import { describeDeskBasics } from '../_shared/desk.testkit.js';
import { SC09 } from './challenge.js'; // registers SC-09 before createApp() inside freshSession
import { SAMPLE, impl, labFor } from './model.js';

const LAB = '/d/scriptorium/polyglot-image';
const STATEMENT = '<?hvwa CANARY ?>';
const LEVELS = ['acolyte', 'inquisitor', 'divine'] as const;

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

// --- Image headers (only the header: what a magic-byte check reads) ---------------------------------------------
const le16 = (n: number) => [n & 0xff, n >> 8];
const gif = (w = 1, h = 1) => Buffer.from([...Buffer.from('GIF89a', 'latin1'), ...le16(w), ...le16(h), 0x80, 0x00, 0x00]);
const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03]);
const webp = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const polyglot = (header: Buffer, tail = STATEMENT) => Buffer.concat([header, Buffer.from(tail, 'latin1')]);

// --- Player helpers ----------------------------------------------------------------------------------------------
const scroll = (filename: string, value: string | Buffer, contentType: string): Part => ({ name: 'scroll', filename, value, contentType });
const upload = (c: Pick<Ctx, 'agent' | 'level'>, parts: readonly Part[]) => {
  const m = multipart(parts);
  return c.agent.post(`${LAB}?level=${c.level}`).set('Content-Type', m.contentType).send(m.body);
};
const fetchScroll = (c: Pick<Ctx, 'agent' | 'level'>, name: string) => c.agent.get(`${LAB}/uploads?level=${c.level}&name=${encodeURIComponent(name)}`);
const preview = (c: Pick<Ctx, 'agent' | 'level'>, name: string) => c.agent.get(`${LAB}/preview?level=${c.level}&name=${encodeURIComponent(name)}`);
/** Upload `bytes` as shell.php claiming `type`, then ask the server for it by that name. */
const shell = (bytes: Buffer, type: string, name = 'shell.php'): Script => async (c) => {
  await upload(c, [scroll(name, bytes, type)]);
  return fetchScroll(c, name);
};

// --- The exploits ------------------------------------------------------------------------------------------------
// Acolyte: the Content-Type the CLIENT writes decides "image": a script that only claims image/gif is stored and run.
const acolyteExploit = shell(Buffer.from(STATEMENT), 'image/gif');
// Inquisitor: the claim is ignored, the header is read: a real GIF header with the statement after it passes.
const inquisitorExploit = shell(polyglot(gif()), 'application/x-php');

describeExploitMatrix<Script>({
  challenge: SC09,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, inquisitor: inquisitorExploit },
  resisted: 'No such scroll.',
  resistedStatus: 404,
  legit: [
    { name: 'a real image', input: (c) => upload(c, [scroll('portrait.gif', placeholderImage({ width: 8, height: 8 }), 'image/gif'), { name: 'caption', value: 'me' }]), expect: /Stored as \/srv\/uploads\// },
    { name: 'the desk page lists the sample image', input: (c) => c.agent.get(`${LAB}?level=${c.level}`), expect: 'pilgrim.gif' },
  ],
  malformed: [{
    name: 'a plain form post is not an upload',
    input: (c) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ scroll: 'x' }),
    levels: ['acolyte', 'inquisitor'],
  }],
  privileged: null,
  errorRe: /Upload error|Storage error/,
});

describeLabView({
  challenge: SC09,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'caption',
  oddBodies: [{ caption: { a: 1 } }, { caption: ['x'] }, [], {}],
  ok: (agent, level) => upload({ agent, level }, [scroll('portrait.gif', placeholderImage({ width: 8, height: 8 }), 'image/gif')]),
  bad: (agent, level) => upload({ agent, level }, [{ name: 'caption', value: 'no file' }]),
});

describeDeskBasics({
  challenge: SC09, path: LAB, heading: 'Profile Image Desk', labFor,
  seed: { name: 'pilgrim.gif', body: SAMPLE },
  accepted: { contentType: 'image/gif', prefix: gif() },
  preview: true,
});

// --- Lab-specific cases ------------------------------------------------------------------------------------------
const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });
const ran = (res: request.Response) => FLAG_RE.test(res.text);
const storedAs = (res: request.Response) => /Stored as \/srv\/uploads\/([^<]+)\.<\/p>/.exec(res.text)?.[1];

describe('SC-09 Acolyte: the uploader\'s Content-Type decides what an image is', () => {
  it('a script that only claims to be an image is stored under its own name and run: the flag, credited at Acolyte', async () => {
    const c = await fresh('acolyte');
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const name = `s-${type.slice(6)}.php`;
      await upload(c, [scroll(name, STATEMENT, type)]);
      expect(ran(await fetchScroll(c, name)), type).toBe(true);
    }
    const flag = (await acolyteExploit(c)).text.match(FLAG_RE)?.[0];
    expect((await c.agent.post('/api/submit').send({ challengeId: SC09.id, submission: flag })).body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('refuses any other claim, even for a real image; a stored file not named .php is never run', async () => {
    const c = await fresh('acolyte');
    for (const type of ['text/plain', 'image/svg+xml', 'application/x-php', 'image/x-icon']) {
      expect((await upload(c, [scroll('real.gif', gif(), type)])).text, type).toContain('Only images are accepted (image/png, image/jpeg, image/gif or image/webp).');
    }
    await upload(c, [scroll('notes.gif', STATEMENT, 'image/gif')]);
    const r = await fetchScroll(c, 'notes.gif');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(FLAG_RE.test((r.body as Buffer).toString('latin1'))).toBe(false);
  });
});

describe('SC-09 Inquisitor: the file\'s own header decides, and only the header is read', () => {
  it('a file whose header is not an image is refused, whatever it claims', async () => {
    const c = await fresh('inquisitor');
    for (const [name, bytes] of [['shell.php', Buffer.from(STATEMENT)], ['x.php', Buffer.from('GIF89a')], ['y.php', Buffer.from('<svg/>')]] as const) {
      const r = await upload(c, [scroll(name, bytes, 'image/gif')]);
      expect(r.text, name).toContain('That file is not a real image.');
      expect((await fetchScroll(c, name)).status, name).toBe(404);
    }
  });

  it.each([['GIF', gif(3, 4)], ['PNG', png(5, 6)], ['JPEG', jpeg(48, 32)], ['WebP', webp(10, 5)]] as const)(
    'a %s header followed by the statement passes as an image and runs, whatever is claimed', async (_t, header) => {
      const c = await fresh('inquisitor');
      expect((await upload(c, [scroll('shell.php', polyglot(header, `\n...anything...\n${STATEMENT}\n`), 'text/plain')])).text).toContain('Stored as /srv/uploads/shell.php.');
      expect(ran(await fetchScroll(c, 'shell.php'))).toBe(true);
    });

  it('the stored file keeps every byte the player sent; one not named .php is an inert download of them', async () => {
    const c = await fresh('inquisitor');
    const bytes = polyglot(gif());
    await upload(c, [scroll('avatar.gif', bytes, 'image/gif')]);
    expect(labFor({ sessionId: c.sid, level: 'inquisitor' }).fs.read('/srv/uploads/avatar.gif')?.bytes.equals(bytes)).toBe(true);
    const r = await fetchScroll(c, 'avatar.gif');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect((r.body as Buffer).equals(bytes)).toBe(true);
  });
});

describe('SC-09 Divine: transcode, don\'t validate', () => {
  it('keeps no byte the player sent: the stored file is exactly placeholderImage(sniff), 35 bytes, under a server-made .gif name', async () => {
    const c = await fresh('divine');
    for (const header of [gif(3, 4), png(5, 6), jpeg(48, 32), webp(10, 5)]) {
      const r = await upload(c, [scroll('shell.php', polyglot(header), 'image/gif')]);
      const name = storedAs(r);
      expect(name).toMatch(/^avatar-[0-9a-f]{12}\.gif$/);
      const file = labFor({ sessionId: c.sid, level: 'divine' }).fs.read(`/srv/uploads/${name as string}`);
      const sniff = sniffImage(header);
      expect(file?.bytes.equals(placeholderImage(sniff as NonNullable<typeof sniff>))).toBe(true);
      expect([file?.bytes.length, file?.contentType]).toEqual([35, 'image/gif']);
      expect(file?.bytes.toString('latin1')).not.toContain('hvwa');
      // The download hands back the server's image, never run, never the player's bytes.
      const d = await fetchScroll(c, name as string);
      expect(d.headers['content-type']).toBe('application/octet-stream');
      expect((d.body as Buffer).equals(file?.bytes as Buffer)).toBe(true);
      expect(ran(d)).toBe(false);
    }
    expect(labFor({ sessionId: c.sid, level: 'divine' }).fs.has('/srv/uploads/shell.php')).toBe(false);
  });

  it('the placeholder has a constant size whatever the header declares: 2^31 - 1 on each side is still 35 bytes, at once', async () => {
    const c = await fresh('divine');
    const t0 = Date.now();
    const r = await upload(c, [scroll('huge.png', png(0x7fffffff, 0x7fffffff), 'image/png')]);
    expect(Date.now() - t0).toBeLessThan(2000);
    const file = labFor({ sessionId: c.sid, level: 'divine' }).fs.read(`/srv/uploads/${storedAs(r) as string}`);
    expect(file?.bytes.length).toBe(35);
    expect(sniffImage(file?.bytes as Buffer)).toMatchObject({ type: 'gif', width: 65535, height: 65535 });
  });

  it('never runs a file, even a .php holding the statement put there by other means (a defense no Divine upload can reach)', async () => {
    const c = await fresh('divine');
    const { fs } = labFor({ sessionId: c.sid, level: 'divine' });
    fs.write('/srv/uploads/planted.php', STATEMENT, { contentType: 'application/x-php' }); // not through the upload
    expect(impl.for('divine').serve(fs, 'planted.php')).toMatchObject({ runs: false });
    const r = await fetchScroll(c, 'planted.php');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(ran(r)).toBe(false);
  });

  it('refuses a file with no image header, generic about why it failed nowhere else', async () => {
    const c = await fresh('divine');
    expect((await upload(c, [scroll('shell.php', STATEMENT, 'image/gif')])).text).toContain('That file is not a real image.');
    expect(labFor({ sessionId: c.sid, level: 'divine' }).fs.size).toBe(1);
  });
});

describe('SC-09 what reaches the player\'s real browser', () => {
  it('the preview shows a stored raster as the type its header says (never the claim), nosniff, CSP sandbox; at Divine the server\'s image', async () => {
    for (const level of LEVELS) {
      const c = await fresh(level);
      const bytes = polyglot(gif(6, 4), '<svg onload=alert(1)><script>alert(1)</script>');
      const name = storedAs(await upload(c, [scroll('face.gif', bytes, 'image/gif')])) as string;
      const r = await preview(c, name);
      expect(r.status, level).toBe(200);
      expect(r.headers['content-type'], level).toBe('image/gif');
      expect([r.headers['x-content-type-options'], r.headers['content-security-policy']], level).toEqual(['nosniff', 'sandbox']);
      expect((r.body as Buffer).equals(level === 'divine' ? placeholderImage({ width: 6, height: 4 }) : bytes), level).toBe(true);
    }
  });

  it('no level renders an upload as markup: the oracle finds no sink and not even the marker on the lab page', async () => {
    const marker = "hvwa('0123456789abcdef')";
    for (const level of LEVELS) {
      const c = await fresh(level);
      await upload(c, [scroll('x.gif', polyglot(gif(), `<svg onload="${marker}"><script>${marker}</script>`), 'image/gif')]);
      await upload(c, [scroll('y.html', polyglot(gif(), `<img src=x onerror="${marker}">`), 'image/gif')]);
      const page = await c.agent.get(`${LAB}?level=${level}`);
      const v = xssOracle(page.text, marker);
      expect([v.executes, v.reachedMarker], level).toEqual([false, false]);
    }
  });

  it('no level ever serves player XML as a document (so none can yield limited: \'dtd\'): an SVG is refused or only downloaded', async () => {
    const svg = '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
    for (const level of LEVELS) {
      const c = await fresh(level);
      for (const type of ['image/svg+xml', 'image/gif']) {
        const r = await upload(c, [scroll('s.svg', svg, type)]);
        if (!r.text.includes('Stored as')) continue; // refused: never stored, never served
        expect([level, type]).toEqual(['acolyte', 'image/gif']); // only Acolyte's claim check lets it in
        expect((await preview(c, 's.svg')).status).toBe(404);
        expect((await fetchScroll(c, 's.svg')).headers['content-type']).toBe('application/octet-stream');
      }
    }
  });

  it('the page shows the verified badge and what an image reader sees in each stored file (escaped)', async () => {
    const c = await fresh('inquisitor');
    await upload(c, [scroll('<b>x</b>.php', polyglot(png(5, 6)), 'image/png')]);
    const page = (await c.agent.get(`${LAB}?level=inquisitor`)).text;
    expect(page).toContain('data-testid="verified-badge"');
    expect(page).toContain('<li><code>pilgrim.gif</code>: GIF, 64 x 64</li>');
    expect(page).toContain('<li><code>&lt;b&gt;x&lt;/b&gt;.php</code>: PNG, 5 x 6</li>');
    expect(page).not.toContain('<b>x</b>');
  });

  it('flags are per player and per level', async () => {
    const a = await fresh('inquisitor');
    const b = await fresh('inquisitor');
    const fa = (await inquisitorExploit(a)).text.match(FLAG_RE)?.[0];
    const fb = (await inquisitorExploit(b)).text.match(FLAG_RE)?.[0];
    expect(fa).toBeDefined();
    expect(fa).not.toBe(fb);
    expect((await a.agent.post('/api/submit').send({ challengeId: SC09.id, submission: fa })).body).toMatchObject({ solved: true, level: 'inquisitor' });
  });
});
