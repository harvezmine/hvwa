// src/districts/scriptorium/sc-10-zip-slip/sc-10.spec.ts — SC-10 ZIP slip.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { multipart, zipOf, type Part, type ZipItem } from '../../../../tests/support/uploads.js';
import type { Level } from '../../../core/levels.js';
import { UPLOAD_LIMITS } from '../../../core/upload.js';
import { SC10 } from './challenge.js'; // registers SC-10 before createApp() inside freshSession
import { RESTORE_DIR, SENTINEL, labFor } from './model.js';

const LAB = '/d/scriptorium/zip-slip';
const STATEMENT = '<?hvwa CANARY ?>';

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

const post = (c: Ctx, parts: readonly Part[]) => {
  const m = multipart(parts);
  return c.agent.post(`${LAB}?level=${c.level}`).set('Content-Type', m.contentType).send(m.body);
};
const archive = (value: string | Buffer, filename = 'restore.zip'): Part => ({ name: 'archive', filename, value, contentType: 'application/zip' });
const restore = (c: Ctx, items: readonly ZipItem[]) => post(c, [archive(zipOf(items))]);
/** An archive whose one entry is named `name` and holds the simulated server's statement. */
const slip = (name: string): Script => (c) => restore(c, [{ name, data: STATEMENT }]);
const welcomeOf = (res: request.Response) => /<pre data-testid="welcome">([\s\S]*?)<\/pre>/.exec(res.text)?.[1]?.trim();
const fixture = (name: string): Buffer => readFileSync(new URL(`../../../../tests/fixtures/upload/${name}`, import.meta.url));

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: the entry name is joined onto the restore folder as is: ../../ climbs out of it, onto the sentinel.
const acolyteExploit = slip('../../templates/welcome.txt');
// Templar: every ../ is removed in ONE pass; ....// leaves ../ behind.
const templarExploit = slip('....//....//templates/welcome.txt');
// Inquisitor: ../ is caught, but the Windows-style server also splits on a backslash.
const inquisitorExploit = slip('..\\..\\templates\\welcome.txt');

describeExploitMatrix<Script>({
  challenge: SC10,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  // The welcome page the sentinel renders is intact at Divine, whichever way the archive tried to reach it.
  resisted: 'Welcome, pilgrim.',
  legit: [
    {
      name: 'a folder and a file inside it',
      input: (c) => restore(c, [{ name: 'notes/' }, { name: 'notes/readme.txt', data: 'hello' }]),
      expect: 'Restored notes/readme.txt to /srv/app/uploads/restore/notes/readme.txt',
    },
    { name: 'the page shows the welcome template', input: (c) => c.agent.get(`${LAB}?level=${c.level}`), expect: 'Welcome, pilgrim.' },
  ],
  malformed: [
    { name: 'not a zip', input: (c) => post(c, [archive('this is not an archive')]), levels: ['acolyte', 'templar', 'inquisitor'] },
    {
      name: 'a plain form post is not an upload',
      input: (c) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ archive: 'x' }),
      levels: ['acolyte', 'templar', 'inquisitor'],
    },
    {
      name: 'an entry larger than the simulated file system holds',
      input: (c) => restore(c, [{ name: 'big.bin', data: Buffer.alloc(130 * 1024, 0x61) }]),
      levels: ['acolyte', 'templar', 'inquisitor'],
    },
  ],
  privileged: null,
  errorRe: /Upload error|Archive error|Storage error/,
});

describeLabView({
  challenge: SC10,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'caption',
  oddBodies: [{ caption: { a: 1 } }, { caption: ['x'] }, [], {}],
  ok: (agent, level, sid) => restore({ agent, level, sid }, [{ name: 'a.txt', data: 'a' }]),
  bad: (agent, level, sid) => post({ agent, level, sid }, [{ name: 'caption', value: 'no file' }]),
});

const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });
const fsOf = (c: Ctx) => labFor({ sessionId: c.sid, level: c.level }).fs;
const paths = (c: Ctx) => fsOf(c).list().map((f) => f.path);
const sentinelText = (c: Ctx) => fsOf(c).read(SENTINEL)?.bytes.toString('utf8');
const ranWith = (res: request.Response) => FLAG_RE.test(res.text);

describe('SC-10 page and state', () => {
  it('GET / at every level: the welcome template, the restore folder, the one statement, Python\'s separator note, the curl line', async () => {
    const { agent, sid } = await freshSession();
    for (const level of SC10.levels) {
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.status, level).toBe(200);
      expect(page.text, level).toContain('Archive Restore');
      expect(page.text, level).toContain('You are signed in as <code>pilgrim</code>');
      expect(welcomeOf(page), level).toBe('Welcome, pilgrim.');
      expect(page.text, level).toContain(`<code>${RESTORE_DIR}</code>`);
      expect(page.text, level).toContain(`<code>${SENTINEL}</code>`);
      expect(page.text, level).toMatch(/<form method="post" enctype="multipart\/form-data">/);
      expect(page.text, level).toContain('<code>&lt;?hvwa CANARY ?&gt;</code>');
      expect(page.text, level).toContain('nothing you upload ever runs for real');
      expect(page.text, level).toMatch(/Python's <code>zipfile<\/code> on Windows turns a backslash in <code>ZipInfo\(name\)<\/code> into a slash[^<]*<code>\.filename<\/code>/);
      expect(page.text, level).toMatch(new RegExp(
        `curl -F 'archive=@\\./local-file;filename=&lt;name&gt;;type=&lt;content type&gt;' -F 'caption=&lt;text&gt;' "http://[^/"]+${LAB}\\?level=${level}" -b "hvwa_sid=&lt;copy from devtools&gt;"`));
      expect(page.text, level).not.toContain(sid);
    }
  });

  it('each level has its own simulated file system; the sentinel is pinned; Inquisitor and Divine split paths on backslashes too', async () => {
    const { sid } = await freshSession();
    const seps: Record<string, string> = {};
    for (const level of SC10.levels) {
      const fs = labFor({ sessionId: sid, level }).fs;
      seps[level] = fs.separators;
      expect(fs.read(SENTINEL)?.pinned, level).toBe(true);
      expect(fs.read(SENTINEL)?.bytes.toString(), level).toBe('Welcome, pilgrim.\n');
    }
    expect(seps).toEqual({ acolyte: '/', templar: '/', inquisitor: '/\\', divine: '/\\' });
  });

  it('a folder entry (a name ending in /) is skipped: no empty file is written for it', async () => {
    const c = await fresh('acolyte');
    const res = await restore(c, [{ name: 'notes/' }, { name: 'notes/readme.txt', data: 'hello' }, { name: 'deep/er/' }]);
    expect(res.text).toContain('Restored 1 of 1 entries.');
    expect(paths(c).filter((p) => p.startsWith(RESTORE_DIR))).toEqual([`${RESTORE_DIR}/README.txt`, `${RESTORE_DIR}/notes/readme.txt`]);
  });

  it('a real archive written by Python (both slip names, a folder, a UTF-8 name): extracted as the level decides', async () => {
    const acolyte = await fresh('acolyte');
    const done = await post(acolyte, [archive(fixture('python-slip.zip'))]);
    expect(done.text).toContain('Restored ünïcode-✓.txt to /srv/app/uploads/restore/ünïcode-✓.txt');
    expect(done.text).toContain('Restored notes/readme.txt to /srv/app/uploads/restore/notes/readme.txt');
    // ../../templates/welcome.txt overwrote the sentinel (300 bytes, no statement: it prints nothing special).
    expect(sentinelText(acolyte)).toContain("hvwa('CANARY')");
    expect(welcomeOf(done)).toContain('hvwa(&#39;CANARY&#39;)'); // (as the page escapes it)
    expect(ranWith(done)).toBe(false); // that is not the simulated server's statement
    const divine = await fresh('divine');
    const refused = await post(divine, [archive(fixture('python-slip.zip'))]);
    expect(refused.text).toContain('Skipped ../../templates/welcome.txt: it would land outside /srv/app/uploads/restore.');
    expect(refused.text).toContain('Skipped ..\\..\\templates\\welcome.txt: absolute and backslash names are not accepted.');
    expect(refused.text).toContain('Restored notes/readme.txt to');
    expect(welcomeOf(refused)).toBe('Welcome, pilgrim.');
  });

  it('names are shown as written but escaped, and a NUL as a visible escape; a body over the cap gets the lab page at 413', async () => {
    const c = await fresh('acolyte');
    const res = await restore(c, [{ name: '<img src=x onerror=alert(1)>.txt', data: 'x' }, { name: Buffer.from('a\0b.txt', 'latin1'), data: 'y' }]);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('Restored &lt;img src=x onerror=alert(1)&gt;.txt to');
    expect(res.text).toContain('Restored a\\u0000b.txt to /srv/app/uploads/restore/a\\u0000b.txt');
    const big = await post(c, [archive(Buffer.alloc(UPLOAD_LIMITS.maxBytes))]);
    expect(big.status).toBe(413);
    expect(big.text).toContain('Archive Restore');
    expect(big.text).toContain('The archive is too large (at most 2 MiB).');
  });

  it('Restart lab brings the sentinel back, at the served level only', async () => {
    const c = await fresh('acolyte');
    await acolyteExploit(c);
    await post({ ...c, level: 'divine' }, [archive(zipOf([{ name: 'x.txt', data: 'x' }]))]);
    expect(sentinelText(c)).toBe(STATEMENT);
    expect(await c.agent.post(`${LAB}/_reset?level=acolyte`)).toMatchObject({ status: 303 });
    expect(sentinelText(c)).toBe('Welcome, pilgrim.\n');
    expect(paths({ ...c, level: 'divine' })).toContain(`${RESTORE_DIR}/x.txt`);
  });

  it('the sentinel is pinned: 40 extractions do not push it out of the file system', async () => {
    const c = await fresh('acolyte');
    for (let i = 0; i < 40; i++) await restore(c, [{ name: `f${i}.txt`, data: `n${i}` }]);
    expect(sentinelText(c)).toBe('Welcome, pilgrim.\n');
    expect(fsOf(c).size).toBeLessThanOrEqual(32);
  });
});

describe('SC-10 archive limits', () => {
  it('an archive that holds more than (honestly declared, 360 KiB) the simulated file system holds (256 KiB in all) is refused as an archive, nothing extracted', async () => {
    for (const level of ['acolyte', 'divine'] as const) {
      const c = await fresh(level);
      const res = await restore(c, [1, 2, 3].map((i) => ({ name: `${i}.bin`, data: Buffer.alloc(120 * 1024, 0x61) })));
      expect(res.text, level).toContain(level === 'divine' ? 'Invalid request.' : 'Archive error');
      expect(res.text, level).not.toContain('Restored');
      expect(paths(c).filter((p) => p.startsWith(RESTORE_DIR))).toEqual([`${RESTORE_DIR}/README.txt`]);
    }
  });
});

describe('SC-10 Acolyte: the entry name is joined onto the restore folder with no check', () => {
  it('../../templates/welcome.txt overwrites the sentinel and the welcome page runs the statement: the flag, credited at Acolyte', async () => {
    const c = await fresh('acolyte');
    const res = await acolyteExploit(c);
    expect(res.text).toContain('Restored ../../templates/welcome.txt to /srv/app/templates/welcome.txt');
    const flag = res.text.match(FLAG_RE)?.[0] as string;
    expect(flag).toBeDefined();
    expect((await c.agent.post('/api/submit').send({ challengeId: SC10.id, submission: flag })).body).toMatchObject({ solved: true, level: 'acolyte' });
    // a plain overwrite without the statement shows the new text and no flag
    await restore(c, [{ name: '../../templates/welcome.txt', data: 'Hacked.' }]);
    expect(welcomeOf(await c.agent.get(`${LAB}?level=acolyte`))).toBe('Hacked.');
  });
});

describe('SC-10 Templar: every ../ is removed, in one pass', () => {
  it('plain ../ is neutralised (the entry lands inside the restore folder); ....// and ..././ leave ../ behind', async () => {
    const c = await fresh('templar');
    const plain = await slip('../../templates/welcome.txt')(c);
    expect(plain.text).toContain('Restored ../../templates/welcome.txt to /srv/app/uploads/restore/templates/welcome.txt');
    expect(welcomeOf(plain)).toBe('Welcome, pilgrim.');
    for (const name of ['....//....//templates/welcome.txt', '..././..././templates/welcome.txt']) {
      const d = await fresh('templar');
      expect(ranWith(await slip(name)(d)), name).toBe(true);
    }
  });
});

describe('SC-10 Inquisitor: ../ is normalised away, but not a backslash, and an absolute name restarts the path', () => {
  it('refuses a name that climbs out after POSIX normalisation, with a reason', async () => {
    const c = await fresh('inquisitor');
    for (const name of ['../../templates/welcome.txt', 'a/../../templates/welcome.txt', './../x.txt', '..']) {
      const res = await slip(name)(c);
      expect(res.text, name).toContain('may not climb out of the restore folder');
    }
    expect(sentinelText(c)).toBe('Welcome, pilgrim.\n');
  });

  it('a backslash name escapes (the server splits on both separators), and so does an absolute name (like os.path.join, it resets the path)', async () => {
    for (const name of ['..\\..\\templates\\welcome.txt', '/srv/app/templates/welcome.txt', '..\\..\\templates/welcome.txt']) {
      const c = await fresh('inquisitor');
      expect(ranWith(await slip(name)(c)), name).toBe(true);
    }
  });

  it('....// still lands inside: ordinary names, not a way out', async () => {
    const c = await fresh('inquisitor');
    const res = await slip('....//....//templates/welcome.txt')(c);
    expect(ranWith(res)).toBe(false);
    expect(res.text).toContain('Restored ....//....//templates/welcome.txt to /srv/app/uploads/restore/..../..../templates/welcome.txt');
  });
});

describe('SC-10 Divine: each entry is resolved under the restore folder and refused if it escapes', () => {
  it('lists an escaping entry as skipped, with the reason, and leaves the sentinel exactly as it was', async () => {
    const c = await fresh('divine');
    const before = fsOf(c).read(SENTINEL)?.bytes.toString();
    const res = await restore(c, [
      { name: '../../templates/welcome.txt', data: STATEMENT },
      { name: '..\\..\\templates\\welcome.txt', data: STATEMENT },
      { name: '/srv/app/templates/welcome.txt', data: STATEMENT },
      { name: 'C:\\srv\\app\\templates\\welcome.txt', data: STATEMENT },
      { name: 'a/../../../templates/welcome.txt', data: STATEMENT },
      { name: 'C:/srv/app/templates/welcome.txt', data: STATEMENT }, // a drive letter with forward slashes: only the drive rule refuses it
      { name: '../restore2/sibling.txt', data: STATEMENT }, // a sibling folder that shares the prefix
      { name: 'ok.txt', data: 'fine' },
    ]);
    expect(res.text).toContain('Skipped ../../templates/welcome.txt: it would land outside /srv/app/uploads/restore.');
    expect(res.text).toContain('Skipped a/../../../templates/welcome.txt: it would land outside /srv/app/uploads/restore.');
    expect(res.text).toContain('Skipped ..\\..\\templates\\welcome.txt: absolute and backslash names are not accepted.');
    expect(res.text).toContain('Skipped /srv/app/templates/welcome.txt: absolute and backslash names are not accepted.');
    expect(res.text).toContain('Skipped C:\\srv\\app\\templates\\welcome.txt: absolute and backslash names are not accepted.');
    expect(res.text).toContain('Restored ok.txt to /srv/app/uploads/restore/ok.txt');
    expect(res.text).toContain('Skipped ../restore2/sibling.txt: it would land outside /srv/app/uploads/restore.');
    expect(res.text).toContain('Skipped C:/srv/app/templates/welcome.txt: absolute and backslash names are not accepted.');
    expect(res.text).toContain('Restored 1 of 8 entries.');
    expect(sentinelText(c)).toBe(before);
    expect(ranWith(res)).toBe(false);
  });

  it('a name that resolves inside the folder is restored where it resolves (containment is judged on the resolved path)', async () => {
    const c = await fresh('divine');
    const res = await restore(c, [{ name: 'a/../b.txt', data: 'b' }, { name: '../restore/c.txt', data: 'c' }, { name: '....//d.txt', data: 'd' }, { name: 'x/./y.txt', data: 'y' }]);
    expect(paths(c).filter((p) => p.startsWith(`${RESTORE_DIR}/`)).sort()).toEqual([
      `${RESTORE_DIR}/..../d.txt`, `${RESTORE_DIR}/README.txt`, `${RESTORE_DIR}/b.txt`, `${RESTORE_DIR}/c.txt`, `${RESTORE_DIR}/x/y.txt`,
    ].sort());
    expect(res.text).toContain('Restored 4 of 4 entries.');
  });

  it('an entry that names the folder itself, or a NUL, is refused without a 500', async () => {
    const c = await fresh('divine');
    const res = await restore(c, [{ name: 'a/..', data: 'x' }, { name: '.', data: 'x' }, { name: Buffer.from('n\0.txt', 'latin1'), data: 'x' }]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Restored 0 of 3 entries.');
    expect(res.text).toContain('Skipped n\\u0000.txt: the name contains a NUL character.');
    expect(res.text).not.toMatch(/Storage error|Archive error/);
    expect(sentinelText(c)).toBe('Welcome, pilgrim.\n');
  });

  it('no response of any exploit round shows a flag', async () => {
    const c = await fresh('divine');
    const seen: string[] = [];
    for (const name of ['../../templates/welcome.txt', '....//....//templates/welcome.txt', '..\\..\\templates\\welcome.txt', '/srv/app/templates/welcome.txt']) {
      seen.push((await slip(name)(c)).text);
    }
    seen.push((await c.agent.get(`${LAB}?level=divine`)).text);
    expect(seen.some((s) => FLAG_RE.test(s))).toBe(false);
  });
});
