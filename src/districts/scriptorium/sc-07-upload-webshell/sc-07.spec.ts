// src/districts/scriptorium/sc-07-upload-webshell/sc-07.spec.ts — SC-07 Upload webshell (extension bypass).
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { multipart, type Part } from '../../../../tests/support/uploads.js';
import type { Level } from '../../../core/levels.js';
import { describeDeskBasics } from '../_shared/desk.testkit.js';
import { SC07 } from './challenge.js'; // registers SC-07 before createApp() inside freshSession
import { labFor } from './model.js';

const LAB = '/d/scriptorium/upload-webshell';
const STATEMENT = '<?hvwa CANARY ?>';

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const upload = (c: Ctx, parts: readonly Part[]) => {
  const m = multipart(parts);
  return c.agent.post(`${LAB}?level=${c.level}`).set('Content-Type', m.contentType).send(m.body);
};
const scroll = (filename: string | Buffer, value: string | Buffer, contentType: string): Part => ({ name: 'scroll', filename, value, contentType });
const fetchScroll = (c: Ctx, name: string) => c.agent.get(`${LAB}/uploads?level=${c.level}&name=${encodeURIComponent(name)}`);
/** Upload a scroll named `filename` that holds the statement, claiming `type`, then ask the server for it by that name. */
const shell = (filename: string, type = 'application/x-php'): Script => async (c) => {
  await upload(c, [scroll(filename, STATEMENT, type)]);
  return fetchScroll(c, filename);
};

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: any extension is accepted and the server runs .php.
const acolyteExploit = shell('shell.php');
// Templar: the denylist refuses .php and .phtml as written; a trailing dot (Windows-like servers strip it before
// mapping the extension) gets past it, and the server still runs the file.
const templarExploit = shell('shell.php.');
// Inquisitor: only images are accepted, judged by the Content-Type the CLIENT claims.
const inquisitorExploit = shell('shell.php', 'image/jpeg');

describeExploitMatrix<Script>({
  challenge: SC07,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'No such scroll.',
  resistedStatus: 404,
  legit: [
    {
      name: 'an image scroll',
      input: (c) => upload(c, [scroll('portrait.jpg', 'JFIF', 'image/jpeg'), { name: 'caption', value: 'my portrait' }]),
      expect: /Stored as \/srv\/uploads\//,
    },
    { name: 'the desk page lists the seed scroll', input: (c) => c.agent.get(`${LAB}?level=${c.level}`), expect: 'README.txt' },
  ],
  malformed: [{
    name: 'a plain form post is not an upload',
    input: (c) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ scroll: 'x' }),
    levels: ['acolyte', 'templar', 'inquisitor'],
  }],
  privileged: null,
  errorRe: /Upload error|Storage error/,
});

describeLabView({
  challenge: SC07,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'caption',
  oddBodies: [{ caption: { a: 1 } }, { caption: ['x'] }, [], {}],
  ok: (agent, level, sid) => upload({ agent, level, sid }, [scroll('portrait.jpg', 'JFIF', 'image/jpeg')]),
  bad: (agent, level, sid) => upload({ agent, level, sid }, [{ name: 'caption', value: 'no file' }]),
});

describeDeskBasics({ challenge: SC07, path: LAB, heading: 'Scroll Desk', labFor });

const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });
const ranWith = (res: request.Response) => FLAG_RE.test(res.text);

describe('SC-07 Acolyte: anything is accepted, and the server runs .php and .ejs', () => {
  it('stores a scroll under the name the uploader gave, whatever its extension', async () => {
    const c = await fresh('acolyte');
    for (const name of ['a.php', 'b.txt', 'c.ejs', 'd', '.htaccess']) {
      expect((await upload(c, [scroll(name, 'x', 'text/plain')])).text).toContain(`Stored as /srv/uploads/${name}.`);
    }
    expect(labFor({ sessionId: c.sid, level: 'acolyte' }).fs.list().map((f) => f.path)).toEqual(expect.arrayContaining(['/srv/uploads/a.php', '/srv/uploads/.htaccess']));
  });

  it('"runs" .php and .ejs scrolls: the flag only when the scroll holds the statement, and the player\'s bytes are never echoed', async () => {
    const c = await fresh('acolyte');
    await upload(c, [scroll('quiet.php', '<?php system("id"); ?> secret-marker-123', 'application/x-php')]);
    const quiet = await fetchScroll(c, 'quiet.php');
    expect(quiet.text).toContain('The server ran /srv/uploads/quiet.php. It printed: (nothing)');
    expect(quiet.text).not.toContain('secret-marker-123');
    await upload(c, [scroll('page.ejs', `before ${STATEMENT} after`, 'text/plain')]);
    expect(ranWith(await fetchScroll(c, 'page.ejs'))).toBe(true);
    // The statement is tolerant of whitespace, and a text scroll holding it is NOT run (no .php/.ejs name).
    await upload(c, [scroll('spaced.php', '<?hvwa   CANARY?>', 'text/plain')]);
    expect(ranWith(await fetchScroll(c, 'spaced.php'))).toBe(true);
    await upload(c, [scroll('notes.txt', STATEMENT, 'text/plain')]);
    expect(ranWith(await fetchScroll(c, 'notes.txt'))).toBe(false);
  });

  it('the flag is this session\'s and this level\'s (credited at Acolyte only)', async () => {
    const c = await fresh('acolyte');
    const flag = (await acolyteExploit(c)).text.match(FLAG_RE)?.[0] as string;
    expect(flag).toBeDefined();
    expect((await c.agent.post('/api/submit').send({ challengeId: SC07.id, submission: flag })).body).toMatchObject({ solved: true, level: 'acolyte' });
    const other = await fresh('acolyte');
    expect((await acolyteExploit(other)).text.match(FLAG_RE)?.[0]).not.toBe(flag);
  });
});

describe('SC-07 Templar: a denylist of .php and .phtml, and a server that maps the extension its own way', () => {
  it('refuses .php and .phtml exactly as written, with a reason', async () => {
    const c = await fresh('templar');
    for (const name of ['shell.php', 'x.phtml', 'a.b.php']) {
      const r = await upload(c, [scroll(name, STATEMENT, 'application/x-php')]);
      expect(r.text, name).toContain('Scrolls ending in .php or .phtml are not accepted.');
      expect(r.text, name).toContain('lab-error');
      expect((await fetchScroll(c, name)).status, name).toBe(404);
    }
  });

  it.each(['shell.pHp', 'shell.PHP', 'shell.php5', 'shell.phar', 'shell.PHTML', 'shell.php.', 'shell.php ', 'shell.php. .', 'shell.php...'])(
    'the denylist misses %j, and the server still runs it', async (name) => {
      const c = await fresh('templar');
      expect((await upload(c, [scroll(name, STATEMENT, 'application/x-php')])).text).toContain(`Stored as /srv/uploads/${name}.`);
      const ran = await fetchScroll(c, name);
      expect(ran.text).toMatch(FLAG_RE);
      // the simulated file system keeps the name exactly: the stripping is the server's mapping, not the storage
      expect(labFor({ sessionId: c.sid, level: 'templar' }).fs.has(`/srv/uploads/${name}`)).toBe(true);
    });

  it('a name that does not map to an interpreter is not run: shell.php.txt, shell.phps, notes.php.bak', async () => {
    const c = await fresh('templar');
    for (const name of ['shell.php.txt', 'shell.phps', 'notes.php.bak']) {
      await upload(c, [scroll(name, STATEMENT, 'text/plain')]);
      const r = await fetchScroll(c, name);
      expect(r.status, name).toBe(200);
      expect(r.headers['content-type'], name).toBe('application/octet-stream');
    }
  });
});

describe('SC-07 Inquisitor: only images, judged by the type the client claims', () => {
  it('refuses a scroll whose claimed type is not an image, whatever its name', async () => {
    const c = await fresh('inquisitor');
    for (const [name, type] of [['shell.php', 'application/x-php'], ['shell.php', 'text/plain'], ['shell.php.', 'application/x-php'], ['x.jpg', 'text/html']] as const) {
      const r = await upload(c, [scroll(name, STATEMENT, type)]);
      expect(r.text, `${name} ${type}`).toContain('Only images are accepted (image/jpeg, image/png or image/gif).');
    }
  });

  it('a claimed image type opens the door: shell.php is stored under its own name and run; any case of the extension', async () => {
    const c = await fresh('inquisitor');
    for (const [name, type] of [['shell.php', 'image/jpeg'], ['shell.PHP', 'image/png'], ['shell.phtml', 'IMAGE/GIF']] as const) {
      await upload(c, [scroll(name, STATEMENT, type)]);
      expect(ranWith(await fetchScroll(c, name)), `${name} ${type}`).toBe(true);
    }
  });

  it('what a genuine image is called is not run, and the server does not strip dots here', async () => {
    const c = await fresh('inquisitor');
    await upload(c, [scroll('portrait.jpg', STATEMENT, 'image/jpeg')]);
    expect((await fetchScroll(c, 'portrait.jpg')).headers['content-type']).toBe('application/octet-stream');
    await upload(c, [scroll('shell.php.', STATEMENT, 'image/jpeg')]);
    expect((await fetchScroll(c, 'shell.php.')).headers['content-type']).toBe('application/octet-stream');
  });
});

describe('SC-07 Divine: a server-made name, a fixed type, never run', () => {
  it('stores under scroll-<12 hex>.bin whatever the uploader called it; the same scroll twice gets two names', async () => {
    const c = await fresh('divine');
    const a = /Stored as (\/srv\/uploads\/scroll-[0-9a-f]{12}\.bin)\./.exec((await upload(c, [scroll('shell.php', STATEMENT, 'image/jpeg')])).text)?.[1];
    const b = /Stored as (\/srv\/uploads\/scroll-[0-9a-f]{12}\.bin)\./.exec((await upload(c, [scroll('shell.php', STATEMENT, 'image/jpeg')])).text)?.[1];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    const fs = labFor({ sessionId: c.sid, level: 'divine' }).fs;
    expect(fs.read(a as string)?.contentType).toBe('application/octet-stream'); // the claim is not kept
    expect(fs.has('/srv/uploads/shell.php')).toBe(false);
  });

  it('a stored scroll is served as an inert download and never run, even one holding the statement and named like a script', async () => {
    const c = await fresh('divine');
    const path = /Stored as \/srv\/uploads\/(scroll-[0-9a-f]{12}\.bin)\./.exec((await upload(c, [scroll('shell.php', STATEMENT, 'application/x-php')])).text)?.[1] as string;
    const served = await fetchScroll(c, path);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toBe('attachment');
    expect(served.body.toString()).toBe(STATEMENT);
    for (const name of ['shell.php', 'shell.php.', 'shell.PHP', '../uploads/' + path, `${path}\u0000.jpg`]) expect((await fetchScroll(c, name)).status, JSON.stringify(name)).toBe(404);
  });

  it('no response of any exploit round shows a flag at Divine: the pages and the bytes of the downloads', async () => {
    const c = await fresh('divine');
    const seen: string[] = [];
    const keep = (r: request.Response) => { seen.push(r.text ?? '', Buffer.isBuffer(r.body) ? r.body.toString('latin1') : ''); };
    keep(await c.agent.get(`${LAB}?level=divine`));
    for (const [name, type] of [['shell.php', 'application/x-php'], ['shell.php.', 'application/x-php'], ['shell.php', 'image/jpeg']] as const) {
      const stored = await upload(c, [scroll(name, STATEMENT, type)]);
      keep(stored);
      keep(await fetchScroll(c, name));
      const path = /Stored as \/srv\/uploads\/(scroll-[0-9a-f]{12}\.bin)\./.exec(stored.text)?.[1] as string;
      keep(await fetchScroll(c, path));
    }
    expect(seen.length).toBe(2 + 3 * 6); // the page, then an upload, a miss and a download per exploit (text and bytes each)
    expect(seen.some((s) => FLAG_RE.test(s))).toBe(false);
  });
});
