// SC-02 Stored XSS (review): the exploit matrix, the view basics, the moderator's button, the XSS proof (test kit), the
// curl line, and SC-02's own cases: the review persists and the moderator reads the newest one later, the bounds on
// reviews, Restart, the review page twin, the Divine sanitizer on its own, and the lab's declared weight.
import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  FLAG_RE, describeExploitMatrix, describeLabView, freshSession, panelOf, type Agent,
} from '../../../../tests/helpers.js';
import { cappedBudgetUsage, setCappedBudget } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { SIM_LIMITS } from '../../../core/sim.js';
import { XSS_LIMITS, xssOracle } from '../../../core/xss.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { describeVictimAction } from '../../_shared/victim-lab.testkit.js';
import {
  describeXssLab, labPage, markerOn, previewSrcdoc, signIn, stealsOn, stolenKey, xssExploit,
} from '../../_shared/xss-lab.testkit.js';
import { SC02 } from './challenge.js'; // registers SC-02 before createApp() inside freshSession
import { MAX_REVIEWS, REVIEW_LENGTH, STATE_WEIGHT, addReview, impl, labState } from './model.js';

const LAB = '/d/scriptorium/stored-xss';
/** The player's moves: post a review; ask the moderator to read the newest review. */
const postReview = (a: Agent, level: Level, review: string) => a.post(`${LAB}?level=${level}`).type('form').send({ intent: 'review', review });
const askModerator = (a: Agent, level: Level) => a.post(`${LAB}/victim/read-review?level=${level}`);
const plantAndRead = async (a: Agent, level: Level, payload: string) => { await postReview(a, level, payload); await askModerator(a, level); };
const exploit = xssExploit(LAB, plantAndRead);
type Script = (a: Agent, level: Level, sid: string) => Promise<request.Response>;

const PAYLOADS = {
  acolyte: (m: string) => `<script>${m}</script>`, // stored and rendered raw
  templar: (m: string) => `<svg onload=${m}>`, // the denylist knows two spellings; an SVG's onload is neither
  inquisitor: (m: string) => `<im<x>g src=x onerror=${m}>`, // removing <x> in one pass joins the outer tag back together
} as const;

describeExploitMatrix<Script>({
  challenge: SC02,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: exploit(PAYLOADS.acolyte), templar: exploit(PAYLOADS.templar), inquisitor: exploit(PAYLOADS.inquisitor) },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a review', input: (a, l) => postReview(a, l, 'A fine psalter, well bound.'), expect: 'Your review was added.' },
    { name: 'a review with bold words', input: (a, l) => postReview(a, l, 'A <b>fine</b> psalter.'), expect: 'A &lt;b&gt;fine&lt;/b&gt; psalter.' },
    { name: 'a wrong key', input: (a, l) => signIn(a, LAB, l, 'nope'), expect: 'Wrong session key.' },
    {
      name: 'the moderator reads a plain review: nothing leaks',
      input: async (a, l) => { await plantAndRead(a, l, 'Plain words.'); return labPage(a, LAB, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
  ],
  malformed: [],
  privileged: {
    name: 'the moderator\'s real session key',
    input: (a, l, sid) => signIn(a, LAB, l, labState(sid, l).key),
    expect: 'Signed in as the moderator.',
  },
});

describeLabView({
  challenge: SC02,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, { intent: 'review', review: ['<b>'] }, { intent: 'review', review: { a: 1 } }, [1, 2], {}],
  ok: (a, level, sid) => signIn(a, LAB, level, labState(sid, level).key),
  bad: (a, level) => signIn(a, LAB, level, 'nope'),
});

describeVictimAction({
  challenge: SC02,
  path: LAB,
  description: {
    en: 'opens the scroll page, then the newest review on it, while signed in',
    id: 'membuka halaman gulungan, lalu ulasan terbaru di sana, dalam keadaan masuk',
  },
  label: { en: 'Ask the moderator to read the newest review', id: 'Minta moderator membaca ulasan terbaru' },
});

describeCurlExample({
  challenge: SC02,
  path: LAB,
  curl: () => ({ path: '', form: ['intent=review', 'review=<your review>'] }),
});

describeXssLab({
  challenge: SC02,
  path: LAB,
  victimOf: labState,
  attack: plantAndRead,
  preview: async (a, level, payload) => { await postReview(a, level, payload); return labPage(a, LAB, level); },
  fragment: (level, payload) => impl.for(level).renderReview(payload),
  payloads: PAYLOADS,
  divineSanitizes: true, // a handler or tag the allowlist drops takes the marker with it
});

describe('SC-02 review lab', () => {
  it('the review persists: posted once, it runs every time the moderator reads it', async () => {
    const { agent, sid } = await freshSession();
    await postReview(agent, 'acolyte', PAYLOADS.acolyte(labState(sid, 'acolyte').marker.call));
    await askModerator(agent, 'acolyte');
    await askModerator(agent, 'acolyte');
    const steals = stealsOn((await labPage(agent, LAB, 'acolyte')).text);
    expect(steals.length).toBe(2);
    expect(stolenKey((await labPage(agent, LAB, 'acolyte')).text)).toBe(labState(sid, 'acolyte').key);
  });

  it('the moderator reads only the newest review, from the scroll page (a click there: its Referer)', async () => {
    const { agent, sid } = await freshSession();
    const lab = labState(sid, 'acolyte');
    await postReview(agent, 'acolyte', PAYLOADS.acolyte(lab.marker.call));
    await postReview(agent, 'acolyte', 'A later, plain review.');
    await askModerator(agent, 'acolyte');
    expect(stealsOn((await labPage(agent, LAB, 'acolyte')).text)).toEqual([]);
    const [scroll, review] = lab.world.visits.slice(-2);
    expect(scroll?.hops.map((h) => h.url)).toEqual(['http://citadel.test/scroll']);
    expect(review?.hops.map((h) => [h.url, h.referer])).toEqual([[`http://citadel.test/review/${lab.reviews.at(-1)?.id}`, 'http://citadel.test/scroll']]);
  });

  it('with no review yet, the moderator has nothing to read (a note, no visit)', async () => {
    const { agent, sid } = await freshSession();
    await askModerator(agent, 'templar');
    for (const lang of ['en', 'id'] as const) {
      const panel = panelOf((await agent.get(`${LAB}?level=templar&lang=${lang}`)).text);
      expect(panel).toContain(lang === 'en' ? 'There is no review to read yet.' : 'Belum ada ulasan untuk dibaca.');
    }
    expect(labState(sid, 'templar').world.visits).toEqual([]);
  });

  it(`keeps the newest ${MAX_REVIEWS} reviews; refuses an empty one and one over ${REVIEW_LENGTH} characters`, async () => {
    const { agent, sid } = await freshSession();
    for (let i = 1; i <= MAX_REVIEWS + 5; i++) await postReview(agent, 'inquisitor', `review ${i}`);
    const lab = labState(sid, 'inquisitor');
    expect(lab.reviews.map((r) => r.body)).toEqual(Array.from({ length: MAX_REVIEWS }, (_, i) => `review ${i + 6}`));
    expect((await postReview(agent, 'inquisitor', '')).text).toContain('Write a review first.');
    const long = await postReview(agent, 'inquisitor', 'x'.repeat(REVIEW_LENGTH + 1));
    expect(long.text).toContain(`A review is at most ${REVIEW_LENGTH} characters.`);
    expect(long.text).toMatch(/class="lab-message lab-error"/);
    expect(lab.reviews.length).toBe(MAX_REVIEWS);
    expect(lab.reviews.at(-1)?.body).toBe(`review ${MAX_REVIEWS + 5}`);
    expect((await postReview(agent, 'inquisitor', 'x'.repeat(REVIEW_LENGTH))).text).toContain('Your review was added.');
  });

  it('Restart drops the reviews, the marker and the stolen key; the flag can be earned again', async () => {
    const { agent, sid } = await freshSession();
    await exploit(PAYLOADS.acolyte)(agent, 'acolyte');
    const before = labState(sid, 'acolyte');
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(303);
    const after = labState(sid, 'acolyte');
    expect(after).not.toBe(before);
    expect(after.reviews).toEqual([]);
    expect(after.key).not.toBe(before.key);
    expect((await signIn(agent, LAB, 'acolyte', before.key)).text).toContain('Wrong session key.');
    expect(markerOn((await labPage(agent, LAB, 'acolyte')).text)).toBe(after.marker.call);
    expect((await exploit(PAYLOADS.acolyte)(agent, 'acolyte')).text).toMatch(FLAG_RE);
  });

  it('the review page is a twin: /review/<id> previews that review for you, the moderator gets the same fragment', async () => {
    const { agent, sid } = await freshSession();
    await postReview(agent, 'templar', 'First.');
    await postReview(agent, 'templar', 'Second <b>one</b>.');
    const [first, second] = labState(sid, 'templar').reviews;
    const res = await agent.get(`${LAB}/review/${second?.id}?level=templar`);
    expect(res.status).toBe(200);
    expect(previewSrcdoc(res.text).endsWith(`<body>${impl.for('templar').renderReview('Second <b>one</b>.')}</body></html>`)).toBe(true);
    expect((await agent.get(`${LAB}/review/${first?.id}?level=templar`)).status).toBe(200);
    expect((await agent.get(`${LAB}/review/999?level=templar`)).status).toBe(404);
    expect((await agent.get(`${LAB}/review/abc?level=templar`)).status).toBe(404);
    expect((await agent.get(`${LAB}/scroll?level=templar`)).status).toBe(200);
  });

  it('inquisitor: a tag the pattern cannot match (another tag starts inside it) survives whole, handler and all', () => {
    const m = "hvwa('0123456789abcdef')";
    expect(impl.for('inquisitor').renderReview(`<img src=x onerror=${m} <b>`)).toBe(`<img src=x onerror=${m} <b>`);
    expect(xssOracle(impl.for('inquisitor').renderReview(`<img src=x onerror=${m} <b>`), m).executes).toBe(true);
    expect(xssOracle(impl.for('divine').renderReview(`<img src=x onerror=${m} <b>`), m).executes).toBe(false);
  });

  it('every level keeps ordinary formatting: bold and italic words render as such', () => {
    for (const level of SC02.levels) {
      expect(impl.for(level).renderReview('A <b>fine</b> and <i>old</i> psalter.'), level).toBe('A <b>fine</b> and <i>old</i> psalter.');
    }
  });

  it('divine: an allowlist on the parsed tree; only bare formatting tags and escaped text come out', () => {
    const { renderReview } = impl.for('divine');
    const m = "hvwa('0123456789abcdef')";
    expect(renderReview('<b onclick="x()">a</b><i title=t>b</i>')).toBe('<b>a</b><i>b</i>');
    expect(renderReview(`<script>${m}</script>`)).toBe('hvwa(&#39;0123456789abcdef&#39;)');
    expect(renderReview('1 < 2 & 3 > "4"')).toBe('1 &lt; 2 &amp; 3 &gt; &quot;4&quot;');
    expect(renderReview('<p>one<br>two</p><blockquote>q</blockquote>')).toBe('<p>one<br>two</p><blockquote>q</blockquote>');
    expect(renderReview('<!-- c --><a href="https://x.test/">x</a>')).toBe('x');
    const corpus = [
      ...Object.values(PAYLOADS).map((p) => p(m)),
      `<scr<x>ipt>${m}</scr<x>ipt>`, `<img src=x onerror=${m}`, `<svg><style><img src=x onerror=${m}></style></svg>`,
      `<math><mtext><table><mglyph><style><img src=x onerror=${m}>`, `<noscript><p title="</noscript><img src=x onerror=${m}>">`,
      `<a href="javascript:${m}">x</a>`, `<b/onmouseover=${m}>x</b>`, `<template><img src=x onerror=${m}></template>`,
    ];
    for (const p of corpus) {
      const out = renderReview(p);
      const v = xssOracle(out, m);
      expect(v.executes || v.mxss, p).toBe(false);
      expect(renderReview(out), `${p}: a fixed point`).toBe(out);
    }
  });

  it('the lab declares what its reviews can hold, at or above the measured worst case', () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
    const longest = (i: number): string => `${i}:`.padEnd(REVIEW_LENGTH, '✓'); // two-byte text, every review at its cap
    const states = Array.from({ length: 6 }, (_, i) => labState(`w02-${i}-${randomBytes(4).toString('hex')}`, 'acolyte'));
    gc(); gc();
    const before = process.memoryUsage();
    for (const s of states) for (let i = 0; i < MAX_REVIEWS + 3; i++) expect(addReview(s, longest(i)).ok).toBe(true); // the route's own path
    gc(); gc();
    const after = process.memoryUsage();
    const measured = ((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)) / states.length;
    for (const s of states) expect(s.reviews.length).toBe(MAX_REVIEWS);
    expect(measured, `SC-02 measured ${(measured / 1024).toFixed(1)} KiB`).toBeLessThan(STATE_WEIGHT);
    expect(STATE_WEIGHT).toBeLessThanOrEqual(256 * 1024);
  });

  it('a new lab instance adds world + browser + verdicts + STATE_WEIGHT to the shared budget', () => {
    const world = SIM_LIMITS.inboxWeight + SIM_LIMITS.attackerLogWeight + SIM_LIMITS.visitsWeight + SIM_LIMITS.browserWeight;
    // Room for one more instance first: this file's sessions fill the shared budget, and an eviction would give bytes back.
    const prev = setCappedBudget(cappedBudgetUsage().bytes + 64 * 1024 * 1024);
    try {
      const before = cappedBudgetUsage().bytes;
      labState(`declared-${randomBytes(4).toString('hex')}`, 'templar');
      expect(cappedBudgetUsage().bytes - before).toBe(world + XSS_LIMITS.verdictsWeight + STATE_WEIGHT);
    } finally {
      setCappedBudget(prev);
    }
  });
});
