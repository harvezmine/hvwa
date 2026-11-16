// src/districts/scriptorium/sc-08-upload-double-ext/sc-08.spec.ts — SC-08 Upload double-extension.
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { multipart, type Part } from '../../../../tests/support/uploads.js';
import type { Level } from '../../../core/levels.js';
import { describeDeskBasics } from '../_shared/desk.testkit.js';
import { SC08 } from './challenge.js'; // registers SC-08 before createApp() inside freshSession
import { labFor } from './model.js';

const LAB = '/d/scriptorium/upload-double-ext';
const STATEMENT = '<?hvwa CANARY ?>';

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const upload = (c: Ctx, parts: readonly Part[]) => {
  const m = multipart(parts);
  return c.agent.post(`${LAB}?level=${c.level}`).set('Content-Type', m.contentType).send(m.body);
};
const scroll = (filename: string | Buffer, value: string | Buffer, contentType = 'image/jpeg'): Part => ({ name: 'scroll', filename, value, contentType });
const fetchScroll = (c: Ctx, name: string) => c.agent.get(`${LAB}/uploads?level=${c.level}&name=${encodeURIComponent(name)}`);
/** Upload a scroll named `sent` that holds the statement, then ask the server for the name it was stored under. */
const shell = (sent: string | Buffer, stored: string = String(sent)): Script => async (c) => {
  await upload(c, [scroll(sent, STATEMENT)]);
  return fetchScroll(c, stored);
};
const ranWith = (res: request.Response) => FLAG_RE.test(res.text);

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: the server runs anything whose name contains .php; nothing is checked on the way in.
const acolyteExploit = shell('shell.php');
// Templar: the image check looks at the LAST extension, the server's mapping at the FIRST.
const templarExploit = shell('shell.php.jpg');
// Inquisitor: the raw name is checked for a php segment, then decoded once; the server ends the name at the NUL.
const inquisitorExploit = shell('shell.php%00.jpg', 'shell.php\u0000.jpg');

describeExploitMatrix<Script>({
  challenge: SC08,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'No such scroll.',
  resistedStatus: 404,
  legit: [
    {
      name: 'an image scroll',
      input: (c) => upload(c, [scroll('portrait.jpg', 'JFIF'), { name: 'caption', value: 'my portrait' }]),
      expect: /Stored as \/srv\/uploads\//,
    },
    {
      name: 'a double-extension name that is not a script',
      input: (c) => upload(c, [scroll('trip.2024.jpg', 'JFIF')]),
      expect: /Stored as \/srv\/uploads\//,
    },
    { name: 'the desk page lists the seed scroll', input: (c) => c.agent.get(`${LAB}?level=${c.level}`), expect: 'README.txt' },
  ],
  malformed: [
    {
      name: 'a plain form post is not an upload',
      input: (c) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ scroll: 'x' }),
      levels: ['acolyte', 'templar', 'inquisitor'],
    },
    { name: 'a name with a broken percent sequence', input: (c) => upload(c, [scroll('bad%zz.jpg', 'JFIF')]), levels: ['inquisitor'] },
  ],
  privileged: null,
  errorRe: /Upload error|Storage error/,
});

describeLabView({
  challenge: SC08,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'caption',
  oddBodies: [{ caption: { a: 1 } }, { caption: ['x'] }, [], {}],
  ok: (agent, level, sid) => upload({ agent, level, sid }, [scroll('portrait.jpg', 'JFIF')]),
  bad: (agent, level, sid) => upload({ agent, level, sid }, [{ name: 'caption', value: 'no file' }]),
});

describeDeskBasics({ challenge: SC08, path: LAB, heading: 'Avatar Desk', labFor });

const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });
const fsOf = (c: Ctx) => labFor({ sessionId: c.sid, level: c.level }).fs;

describe('SC-08 Acolyte: the server runs anything whose name contains .php', () => {
  it('accepts any name, and runs shell.php, avatar.php.jpg and a.php5 (Apache-style multi-extension) but not a name without .php', async () => {
    const c = await fresh('acolyte');
    for (const name of ['shell.php', 'avatar.php.jpg', 'a.php5']) {
      expect((await upload(c, [scroll(name, STATEMENT)])).text, name).toContain(`Stored as /srv/uploads/${name}.`);
      expect(ranWith(await fetchScroll(c, name)), name).toBe(true);
    }
    for (const name of ['phpinfo.txt', 'avatar.jpg', 'notes.PHP']) {
      await upload(c, [scroll(name, STATEMENT)]);
      expect((await fetchScroll(c, name)).headers['content-type'], name).toBe('application/octet-stream');
    }
  });

  it('a .php scroll without the statement prints nothing, and the player\'s bytes are not echoed', async () => {
    const c = await fresh('acolyte');
    await upload(c, [scroll('quiet.php', '<?php echo 1; ?> secret-marker-456')]);
    const r = await fetchScroll(c, 'quiet.php');
    expect(r.text).toContain('It printed: (nothing)');
    expect(r.text).not.toContain('secret-marker-456');
  });
});

describe('SC-08 Templar: the last extension is checked, the first one is mapped', () => {
  it('accepts only names whose LAST extension is an image extension (any case), with a reason otherwise', async () => {
    const c = await fresh('templar');
    for (const name of ['shell.php', 'shell.phtml', 'shell.jpg.php', 'noextension', 'shell.jpg.', 'x.gif.exe']) {
      const r = await upload(c, [scroll(name, STATEMENT)]);
      expect(r.text, name).toContain('Only .jpg, .jpeg, .png and .gif scrolls are accepted.');
      expect((await fetchScroll(c, name)).status, name).toBe(404);
    }
    for (const name of ['a.jpg', 'a.JPEG', 'a.png', 'a.Gif']) {
      expect((await upload(c, [scroll(name, 'x')])).text, name).toContain(`Stored as /srv/uploads/${name}.`);
    }
  });

  it.each(['shell.php.jpg', 'shell.PHP.JPG', 'a.php.png', 'shell.php.gif', 'x.php.y.z.jpg'])('%s passes the check and is run by its first extension', async (name) => {
    const c = await fresh('templar');
    expect((await upload(c, [scroll(name, STATEMENT)])).text).toContain(`Stored as /srv/uploads/${name}.`);
    expect(ranWith(await fetchScroll(c, name))).toBe(true);
  });

  it('only the first extension counts: shell.jpg.php.png and x.phpx.jpg are stored but not run; nothing is decoded here', async () => {
    const c = await fresh('templar');
    for (const name of ['shell.jpg.php.png', 'x.phpx.jpg', 'shell.php%00.jpg', 'shell%2ephp.jpg']) {
      expect((await upload(c, [scroll(name, STATEMENT)])).text, name).toContain(`Stored as /srv/uploads/${name}.`);
      expect(ranWith(await fetchScroll(c, name)), name).toBe(false);
    }
    expect(fsOf(c).has('/srv/uploads/shell.php%00.jpg')).toBe(true); // kept as sent: the percent sequence is just characters
  });
});

describe('SC-08 Inquisitor: a php segment in the raw name is refused, then the name is decoded once', () => {
  it('refuses any dot-separated segment equal to php, in any case, in the name as sent', async () => {
    const c = await fresh('inquisitor');
    for (const name of ['shell.php', 'shell.PHP', 'shell.php.jpg', 'x.Php.png', 'a.b.php.c', '.php']) {
      const r = await upload(c, [scroll(name, STATEMENT)]);
      expect(r.text, name).toContain('Scrolls with a php extension are not accepted.');
      expect(fsOf(c).has(`/srv/uploads/${name}`), name).toBe(false);
    }
  });

  it.each([
    ['shell.php%00.jpg', 'shell.php\u0000.jpg'],
    ['shell%2ephp', 'shell.php'],
    ['shell%2Ephp', 'shell.php'],
    ['shell.php%2ejpg', 'shell.php.jpg'],
    [Buffer.from('shell.php\0.jpg', 'latin1'), 'shell.php\u0000.jpg'],
  ] as const)('%j gets past the raw check; the stored name is %j and the server runs it', async (sent, stored) => {
    const c = await fresh('inquisitor');
    await upload(c, [scroll(sent, STATEMENT)]);
    expect(fsOf(c).has(`/srv/uploads/${stored}`)).toBe(true);
    expect(ranWith(await fetchScroll(c, stored))).toBe(true);
  });

  it('decodes ONCE: a doubly encoded dot is stored as a single-encoded name and is not run; the page shows the NUL as a visible escape', async () => {
    const c = await fresh('inquisitor');
    await upload(c, [scroll('shell%252ephp', STATEMENT)]);
    expect(fsOf(c).has('/srv/uploads/shell%2ephp')).toBe(true);
    expect(ranWith(await fetchScroll(c, 'shell%2ephp'))).toBe(false);
    const page = await upload(c, [scroll('shell.php%00.jpg', STATEMENT)]);
    expect(page.text).toContain('Stored as /srv/uploads/shell.php\\u0000.jpg.');
  });

  it('the mapping ends the name at a NUL and takes the first extension: a name with no php before the NUL is not run', async () => {
    const c = await fresh('inquisitor');
    for (const sent of ['shell.jpg%00.php5', 'a%00.php.x']) {
      await upload(c, [scroll(sent, STATEMENT)]);
      expect(ranWith(await fetchScroll(c, sent.replace('%00', '\u0000'))), sent).toBe(false);
    }
  });
});

describe('SC-08 Divine: an opaque server-made name, one fixed extension, no decoding', () => {
  it('stores under scroll-<12 hex>.bin whatever the uploader called it, encoded or not; names are never decoded', async () => {
    const c = await fresh('divine');
    const names: string[] = [];
    for (const sent of ['shell.php', 'shell.php%00.jpg', 'shell%2ephp', 'shell.php.jpg']) {
      const m = /Stored as (\/srv\/uploads\/scroll-[0-9a-f]{12}\.bin)\./.exec((await upload(c, [scroll(sent, STATEMENT)])).text);
      expect(m, sent).not.toBeNull();
      names.push(m?.[1] as string);
    }
    expect(new Set(names).size).toBe(4);
    expect(fsOf(c).list().map((f) => f.path).sort()).toEqual(['/srv/uploads/README.txt', ...names].sort());
    expect(fsOf(c).read(names[0])?.contentType).toBe('application/octet-stream');
  });

  it('a stored scroll is an inert download, never run; no request spelling reaches it through the sent name', async () => {
    const c = await fresh('divine');
    const stored = /Stored as \/srv\/uploads\/(scroll-[0-9a-f]{12}\.bin)\./.exec((await upload(c, [scroll('shell.php.jpg', STATEMENT)])).text)?.[1] as string;
    const served = await fetchScroll(c, stored);
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.body.toString()).toBe(STATEMENT);
    for (const name of ['shell.php.jpg', 'shell.php', 'shell.php\u0000.jpg', '../uploads/' + stored, `${stored}\u0000.jpg`]) {
      expect((await fetchScroll(c, name)).status, JSON.stringify(name)).toBe(404);
    }
  });

  it('no response of any exploit round shows a flag at Divine: the pages and the bytes of the downloads', async () => {
    const c = await fresh('divine');
    const seen: string[] = [];
    const keep = (r: request.Response) => { seen.push(r.text ?? '', Buffer.isBuffer(r.body) ? r.body.toString('latin1') : ''); };
    keep(await c.agent.get(`${LAB}?level=divine`));
    for (const sent of ['shell.php', 'shell.php.jpg', 'shell.php%00.jpg', 'shell%2ephp']) {
      const stored = await upload(c, [scroll(sent, STATEMENT)]);
      keep(stored);
      keep(await fetchScroll(c, sent));
      const path = /Stored as \/srv\/uploads\/(scroll-[0-9a-f]{12}\.bin)\./.exec(stored.text)?.[1] as string;
      keep(await fetchScroll(c, path));
    }
    expect(seen.length).toBe(2 + 4 * 6);
    expect(seen.some((s) => FLAG_RE.test(s))).toBe(false);
  });
});
