// src/districts/scriptorium/sc-11-path-traversal/sc-11.spec.ts — SC-11 Path traversal download.
import { describe, it, expect, onTestFinished } from 'vitest';
import type request from 'supertest';
import {
  freshSession, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { setPerSessionDefaults } from '../../../core/lab.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { SC11 } from './challenge.js'; // registers SC-11 before createApp() inside freshSession
import { VAULT_FLAG, labFor } from './model.js';

const LAB = '/d/scriptorium/path-traversal';

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

/** GET download with a RAW query string: what is encoded and how is the lesson, so nothing here re-encodes it. */
const download = (query: string): Script => (c) => c.agent.get(`${LAB}/download?level=${c.level}&${query}`);
/** The page's own form: a POST of one field, the contents shown on the page. */
const fetchByForm = (c: Ctx, file: string) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ file });
const ranWith = (res: request.Response) => FLAG_RE.test(res.text);

// --- The exploits ---------------------------------------------------------------------------
// Acolyte: the name is appended to /public/ as is.
const acolyteExploit = download('file=../vault/flag.txt');
// Templar: ../ is removed in one pass; ....// leaves one behind.
const templarExploit = download('file=....//vault/flag.txt');
// Inquisitor: ../ (even encoded once: Express decodes the query once) is refused, but the name is decoded AGAIN after
// the check, so a doubly encoded ../ gets through.
const inquisitorExploit = download('file=%252e%252e%252fvault%252fflag.txt');

describeExploitMatrix<Script>({
  challenge: SC11,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'No such scroll.',
  resistedStatus: 404,
  legit: [
    { name: 'download a public scroll', input: download('file=psalms.txt'), expect: 'Blessed is the pilgrim' },
    { name: 'the library lists the public scrolls', input: (c) => c.agent.get(`${LAB}?level=${c.level}`), expect: 'litany.txt' },
    { name: 'the form shows a scroll on the page', input: (c) => fetchByForm(c, 'glossary.txt'), expect: 'Glossary of the Scriptorium' },
  ],
  malformed: [{ name: 'a broken percent sequence in the form', input: (c) => fetchByForm(c, 'bad%zz.txt'), levels: ['inquisitor'] }],
  privileged: null,
  errorRe: /Download error/,
});

describeLabView({
  challenge: SC11,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'file',
  oddBodies: [{ file: { a: 1 } }, { file: ['x'] }, [], {}],
  ok: (agent, level, sid) => fetchByForm({ agent, level, sid }, 'psalms.txt'),
  bad: (agent, level, sid) => fetchByForm({ agent, level, sid }, 'nope.txt'),
});

describeCurlExample({
  challenge: SC11,
  path: LAB,
  curl: () => ({ path: '', form: ['file=<scroll name>'] }),
});

const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });

describe('SC-11 the library', () => {
  it('GET / at every level: the scrolls linked by absolute path, the form with no action, the vault is not listed', async () => {
    const { agent } = await freshSession();
    for (const level of SC11.levels) {
      const page = await agent.get(`${LAB}?level=${level}`);
      expect(page.status, level).toBe(200);
      expect(page.text, level).toContain('Scroll Library');
      expect(page.text, level).toContain('You are signed in as <code>pilgrim</code>');
      for (const name of ['psalms.txt', 'litany.txt', 'glossary.txt']) {
        expect(page.text, level).toContain(`href="${LAB}/download?level=${level}&amp;file=${name}"`);
      }
      expect(page.text, level).not.toContain('flag.txt'); // the vault is mentioned, its file is not named
      expect(page.text, level).toMatch(/<form method="post">/);
    }
  });

  it('a download is plain text with nosniff and a sandbox CSP; the form shows the contents on the page', async () => {
    const { agent } = await freshSession();
    for (const level of SC11.levels) {
      const r = await agent.get(`${LAB}/download?level=${level}&file=psalms.txt`);
      expect(r.status, level).toBe(200);
      expect(r.headers['content-type'], level).toMatch(/^text\/plain/);
      expect([r.headers['x-content-type-options'], r.headers['content-security-policy']], level).toEqual(['nosniff', 'sandbox']);
      const page = await agent.post(`${LAB}?level=${level}`).type('form').send({ file: 'psalms.txt' });
      expect(page.text, level).toContain('<pre data-testid="contents">Blessed is the pilgrim');
    }
  });

  it('an empty or missing name, or an odd type of value, is a plain miss and never a 500', async () => {
    const { agent } = await freshSession();
    for (const level of SC11.levels) {
      for (const q of ['', 'file=', 'file[]=a', 'file=a&file=b', `file=${'a'.repeat(3000)}`, 'file=%00', 'file=.', 'file=..', 'file=/']) {
        const r = await agent.get(`${LAB}/download?level=${level}${q ? `&${q}` : ''}`);
        expect([r.status, ranWith(r)], `${level} ${q.slice(0, 30)}`).toSatisfy(([s, flag]: [number, boolean]) => [400, 404].includes(s) && !flag);
      }
    }
  });

  it('the vault holds this session\'s flag at every level but Divine (where it holds none); flags differ by level and session', async () => {
    const a = await freshSession();
    const b = await freshSession();
    const flags = new Set<string>();
    for (const level of LEVELS.filter((l) => l !== 'divine')) {
      const text = labFor({ sessionId: a.sid, level }).fs.read(VAULT_FLAG)?.bytes.toString('utf8') ?? '';
      expect(text, level).toMatch(FLAG_RE);
      flags.add(text.trim());
    }
    flags.add((labFor({ sessionId: b.sid, level: 'acolyte' }).fs.read(VAULT_FLAG)?.bytes.toString('utf8') ?? '').trim());
    expect(flags.size).toBe(4);
    expect(labFor({ sessionId: a.sid, level: 'divine' }).fs.read(VAULT_FLAG)?.bytes.toString('utf8')).not.toMatch(FLAG_RE);
  });

  it('each level has its own simulated file system; Inquisitor splits paths on backslashes too; the vault and scrolls are pinned', async () => {
    const { sid } = await freshSession();
    const seps: Record<string, string> = {};
    for (const level of SC11.levels) {
      const fs = labFor({ sessionId: sid, level }).fs;
      seps[level] = fs.separators;
      for (const p of [VAULT_FLAG, '/public/psalms.txt']) expect(fs.read(p)?.pinned, `${level} ${p}`).toBe(true);
    }
    expect(seps).toEqual({ acolyte: '/', templar: '/', inquisitor: '/\\', divine: '/' });
  });
});

describe('SC-11 the first lab instance', () => {
  it('is built outside tryDb: the 429 of the platform passes through a download and the form, never a Download error', async () => {
    setPerSessionDefaults({ maxNewPerMinute: 1 });
    onTestFinished(() => { setPerSessionDefaults({ maxNewPerMinute: Infinity }); });
    for (const level of ['acolyte', 'divine'] as const) {
      const a = await freshSession();
      const b = await freshSession();
      const c = await freshSession();
      await a.agent.get(`${LAB}?level=${level}`);
      const get = await download('file=psalms.txt')({ agent: b.agent, level, sid: b.sid });
      const post = await fetchByForm({ agent: c.agent, level, sid: c.sid }, 'psalms.txt');
      for (const r of [get, post]) {
        expect([r.status, level]).toEqual([429, level]);
        expect(r.text).not.toContain('Download error');
      }
    }
  });
});

describe('SC-11 Acolyte: /public/ + the name, no check', () => {
  it('../ reaches the vault, however far up; other spellings that are not separators here do not', async () => {
    const c = await fresh('acolyte');
    for (const q of ['file=../vault/flag.txt', 'file=../../../vault/flag.txt', 'file=%2e%2e%2fvault%2fflag.txt', 'file=x/../../vault/flag.txt']) {
      expect(ranWith(await download(q)(c)), q).toBe(true);
    }
    // on a POSIX server a backslash is an ordinary character, and an absolute name is just appended
    for (const q of ['file=..%5cvault%5cflag.txt', 'file=/vault/flag.txt', 'file=%252e%252e%252fvault%252fflag.txt']) {
      expect(ranWith(await download(q)(c)), q).toBe(false);
    }
  });

  it('the form reads the same way: the vault file shown as text on the page', async () => {
    const c = await fresh('acolyte');
    expect(ranWith(await fetchByForm(c, '../vault/flag.txt'))).toBe(true);
  });
});

describe('SC-11 Templar: every ../ is removed once', () => {
  it('a plain ../ lands inside /public/ (a miss); ....// and ..././ leave ../ behind; encoding once does not help', async () => {
    const c = await fresh('templar');
    for (const q of ['file=../vault/flag.txt', 'file=%2e%2e%2fvault%2fflag.txt', 'file=..%5cvault%5cflag.txt']) {
      const r = await download(q)(c);
      expect([r.status, ranWith(r)], q).toEqual([404, false]);
    }
    for (const q of ['file=....//vault/flag.txt', 'file=..././vault/flag.txt', 'file=....//....//vault/flag.txt']) {
      expect(ranWith(await download(q)(c)), q).toBe(true);
    }
  });
});

describe('SC-11 Inquisitor: ../, backslash and absolute names are refused as they arrive, then the name is decoded again', () => {
  it('refuses a parent segment on either separator, an absolute name and a single-encoded ../ (Express already decoded it once), with a reason', async () => {
    const c = await fresh('inquisitor');
    for (const q of ['file=../vault/flag.txt', 'file=..%5cvault%5cflag.txt', 'file=%2e%2e%2fvault%2fflag.txt', 'file=/vault/flag.txt',
      'file=%5cvault%5cflag.txt', 'file=a/../../vault/flag.txt', 'file=a%5c..%5c..%5cvault%5cflag.txt']) {
      const r = await download(q)(c);
      expect([r.status, r.text], q).toEqual([400, 'That name is not allowed.']);
    }
  });

  it('a doubly encoded ../ , a doubly encoded backslash and a doubly encoded absolute name all get through; a third layer does not', async () => {
    const c = await fresh('inquisitor');
    for (const q of ['file=%252e%252e%252fvault%252fflag.txt', 'file=..%255cvault%255cflag.txt', 'file=%252fvault%252fflag.txt',
      'file=%252e%252e%255cvault%255cflag.txt']) {
      expect(ranWith(await download(q)(c)), q).toBe(true);
    }
    const third = await download('file=%25252e%25252e%25252fvault%25252fflag.txt')(c);
    expect([third.status, ranWith(third)]).toEqual([404, false]);
  });

  it('....// is an ordinary name here: a miss; a broken percent sequence is a download error below Divine', async () => {
    const c = await fresh('inquisitor');
    const r = await download('file=....//vault/flag.txt')(c);
    expect([r.status, ranWith(r)]).toEqual([404, false]);
    const bad = await download('file=bad%25zz')(c);
    expect([bad.status, bad.text]).toEqual([400, 'Download error: URI malformed']);
  });
});

describe('SC-11 Divine: a scroll is looked up by name in a fixed list; no path is ever built from the input', () => {
  it('serves each listed scroll, and answers every other name with the same 404, whatever it is', async () => {
    const c = await fresh('divine');
    for (const name of ['psalms.txt', 'litany.txt', 'glossary.txt']) {
      const r = await download(`file=${name}`)(c);
      expect([r.status, r.text.length > 0, ranWith(r)], name).toEqual([200, true, false]);
    }
    const misses = new Set<string>();
    for (const q of ['file=../vault/flag.txt', 'file=....//vault/flag.txt', 'file=%252e%252e%252fvault%252fflag.txt', 'file=%2e%2e%2fvault%2fflag.txt',
      'file=..%5cvault%5cflag.txt', 'file=/vault/flag.txt', 'file=flag.txt', 'file=vault/flag.txt', 'file=/public/psalms.txt', 'file=public/psalms.txt',
      'file=PSALMS.TXT', 'file=psalms.txt%20', 'file=psalms.txt%00', 'file=__proto__', 'file=constructor', 'file=toString', 'file=bad%25zz', 'file=']) {
      const r = await download(q)(c);
      expect(r.status, q).toBe(404);
      expect(ranWith(r), q).toBe(false);
      misses.add(`${r.status} ${r.headers['content-type']} ${r.text}`);
    }
    expect(misses.size).toBe(1); // uniform: no file-exists oracle
  });

  it('the form at Divine gives the same answer for every miss, and no flag in any response of any exploit round', async () => {
    const c = await fresh('divine');
    const seen: string[] = [];
    for (const q of ['file=../vault/flag.txt', 'file=....//vault/flag.txt', 'file=%252e%252e%252fvault%252fflag.txt']) seen.push((await download(q)(c)).text);
    for (const file of ['../vault/flag.txt', '....//vault/flag.txt', '../../vault/flag.txt']) seen.push((await fetchByForm(c, file)).text);
    seen.push((await c.agent.get(`${LAB}?level=divine`)).text);
    expect(seen.some((s) => FLAG_RE.test(s))).toBe(false);
  });
});
