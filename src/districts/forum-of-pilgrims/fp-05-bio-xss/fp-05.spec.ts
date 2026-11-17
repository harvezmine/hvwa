// FP-05 Stored XSS (bio): the exploit matrix, the view basics, the moderator's button, the XSS proof (test kit), the
// curl line, and FP-05's own cases: the bio's two contexts (an attribute at Templar, allowed tags at Inquisitor), the
// scheme check as written vs as the browser parses it, the Divine sanitizer on its own, the bio's bounds, Restart, the
// profile page twin, and the lab's declared weight.
import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FLAG_RE, describeExploitMatrix, describeLabView, freshSession, type Agent } from '../../../../tests/helpers.js';
import { cappedBudgetUsage, setCappedBudget } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { SIM_LIMITS } from '../../../core/sim.js';
import { XSS_LIMITS, xssOracle } from '../../../core/xss.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { describeVictimAction } from '../../_shared/victim-lab.testkit.js';
import { describeXssLab, labPage, markerOn, previewSrcdoc, signIn, stealsOn, xssExploit } from '../../_shared/xss-lab.testkit.js';
import { FP05 } from './challenge.js'; // registers FP-05 before createApp() inside freshSession
import { BIO_LENGTH, STATE_WEIGHT, impl, labState, saveBio } from './model.js';

const LAB = '/d/forum-of-pilgrims/bio-xss';
/** The player's moves: save the bio; ask the moderator to review the profile. */
const saveMyBio = (a: Agent, level: Level, bio: string) => a.post(`${LAB}?level=${level}`).type('form').send({ intent: 'bio', bio });
const askModerator = (a: Agent, level: Level) => a.post(`${LAB}/victim/view-profile?level=${level}`);
const plantAndView = async (a: Agent, level: Level, bio: string) => { await saveMyBio(a, level, bio); await askModerator(a, level); };
const exploit = xssExploit(LAB, plantAndView);
type Script = (a: Agent, level: Level, sid: string) => Promise<request.Response>;
const M = "hvwa('0123456789abcdef')";
const fires = (level: Level, bio: string): boolean => xssOracle(impl.for(level).renderBio(bio), M).executes;

const PAYLOADS = {
  acolyte: (m: string) => `<script>${m}</script>`, // the bio is rendered raw
  templar: (m: string) => `A pilgrim" onmouseover="${m}`, // < and > are escaped, but the tooltip attribute ends at a quote
  inquisitor: (m: string) => `<a href="java\nscript:${m}">my psalms</a>`, // the scheme is checked as written, not as parsed
} as const;

describeExploitMatrix<Script>({
  challenge: FP05,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: exploit(PAYLOADS.acolyte), templar: exploit(PAYLOADS.templar), inquisitor: exploit(PAYLOADS.inquisitor) },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a bio', input: (a, l) => saveMyBio(a, l, 'Walking to the citadel since spring.'), expect: 'Your bio was saved.' },
    { name: 'a bio with bold words', input: (a, l) => saveMyBio(a, l, 'I copy <b>psalms</b>.'), expect: 'I copy &lt;b&gt;psalms&lt;/b&gt;.' },
    { name: 'a wrong key', input: (a, l) => signIn(a, LAB, l, 'nope'), expect: 'Wrong session key.' },
    {
      name: 'the moderator views a plain profile: nothing leaks',
      input: async (a, l) => { await plantAndView(a, l, 'Plain words.'); return labPage(a, LAB, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
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
  challenge: FP05,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, { intent: 'bio', bio: ['<b>'] }, { intent: 'bio', bio: { a: 1 } }, [1, 2], {}],
  ok: (a, level, sid) => signIn(a, LAB, level, labState(sid, level).key),
  bad: (a, level) => signIn(a, LAB, level, 'nope'),
});

describeVictimAction({
  challenge: FP05,
  path: LAB,
  description: { en: 'opens your public profile, while signed in', id: 'membuka profil publik Anda, dalam keadaan masuk' },
  label: { en: 'Ask the moderator to review your profile', id: 'Minta moderator meninjau profil Anda' },
});

describeCurlExample({
  challenge: FP05,
  path: LAB,
  curl: () => ({ path: '', form: ['intent=bio', 'bio=<your bio>'] }),
});

describeXssLab({
  challenge: FP05,
  path: LAB,
  victimOf: labState,
  attack: plantAndView,
  preview: async (a, level, payload) => { await saveMyBio(a, level, payload); return labPage(a, LAB, level); },
  fragment: (level, payload) => impl.for(level).renderBio(payload),
  payloads: PAYLOADS,
  divineSanitizes: true, // a handler or a link the allowlist drops takes the marker with it
});

describe('FP-05 bio lab', () => {
  it('templar: < and > are escaped everywhere, but the tooltip is an attribute, and a quote ends it', () => {
    expect(fires('templar', PAYLOADS.templar(M))).toBe(true);
    expect(fires('templar', PAYLOADS.acolyte(M))).toBe(false);
    expect(fires('templar', `<img src=x onerror=${M}>`)).toBe(false);
    expect(impl.for('templar').renderBio('a <b>"b"</b>')).toContain('title="a &lt;b&gt;"b"&lt;/b&gt;"');
  });

  it('inquisitor: three tags come back, and an href is refused when it STARTS with javascript: as written', () => {
    expect(impl.for('inquisitor').renderBio('<b>a</b> <i>b</i> <a href="https://psalms.test/">c</a>'))
      .toBe('<div class="bio"><b>a</b> <i>b</i> <a href="https://psalms.test/">c</a></div>');
    for (const href of [`javascript:${M}`, `JAVASCRIPT:${M}`, ` javascript:${M}`]) expect(fires('inquisitor', `<a href="${href}">x</a>`), href).toBe(false);
    for (const href of [`java\nscript:${M}`, `java\tscript:${M}`, `\u0001javascript:${M}`]) expect(fires('inquisitor', `<a href="${href}">x</a>`), JSON.stringify(href)).toBe(true);
    // Allowed tags come back bare: a handler on one stays escaped text; so does any other tag.
    expect(fires('inquisitor', `<b onmouseover=${M}>x</b>`)).toBe(false);
    expect(fires('inquisitor', `<a href="x" onmouseover="${M}">x</a>`)).toBe(false);
    expect(fires('inquisitor', PAYLOADS.templar(M))).toBe(false);
  });

  it('divine: an allowlist on the parsed tree (b, i, and a with an http/https/mailto href as the browser parses it)', () => {
    const { renderBio } = impl.for('divine');
    expect(renderBio('<b onclick="x()">a</b> <a href="https://psalms.test/?a=1&b=2" title="t">c</a>'))
      .toBe('<div class="bio"><b>a</b> <a href="https://psalms.test/?a=1&amp;b=2">c</a></div>');
    expect(renderBio('<a href="mailto:pilgrim@citadel.test">mail</a>')).toBe('<div class="bio"><a href="mailto:pilgrim@citadel.test">mail</a></div>');
    // No attribute but a link's href survives: not style either (CSS can hide, overlay or restyle the page).
    expect(renderBio('<b style="position:fixed;inset:0">a</b><i style=x>b</i><a href="https://x.test/" style="x">c</a>'))
      .toBe('<div class="bio"><b>a</b><i>b</i><a href="https://x.test/">c</a></div>');
    expect(renderBio(`<a href="java\nscript:${M}">x</a>`)).toBe('<div class="bio">x</div>');
    expect(renderBio('A pilgrim" title="x')).toBe('<div class="bio">A pilgrim&quot; title=&quot;x</div>');
    const corpus = [
      ...Object.values(PAYLOADS).map((p) => p(M)),
      `<a href="\u0001javascript:${M}">x</a>`, `<a href=" JavaScript:${M}">x</a>`, `<a href="jav&#x09;ascript:${M}">x</a>`,
      `<b/onmouseover=${M}>x</b>`, `<svg onload=${M}>`, `<im<x>g src=x onerror=${M}>`, `<img src=x onerror=${M}`,
      `<math><mtext><table><mglyph><style><img src=x onerror=${M}>`, `<a href="data:text/html,<script>${M}</script>">x</a>`,
    ];
    for (const p of corpus) {
      const out = renderBio(p);
      const v = xssOracle(out, M);
      expect(v.executes || v.mxss, p).toBe(false);
      expect(renderBio(out.slice('<div class="bio">'.length, -'</div>'.length)), `${p}: a fixed point`).toBe(out);
    }
  });

  it(`the bio is one value: saving replaces it; over ${BIO_LENGTH} characters is refused and changes nothing`, async () => {
    const { agent, sid } = await freshSession();
    await saveMyBio(agent, 'templar', 'first');
    await saveMyBio(agent, 'templar', 'second');
    expect(labState(sid, 'templar').bio).toBe('second');
    const long = await saveMyBio(agent, 'templar', 'x'.repeat(BIO_LENGTH + 1));
    expect(long.text).toContain(`A bio is at most ${BIO_LENGTH} characters.`);
    expect(long.text).toMatch(/class="lab-message lab-error"/);
    expect(labState(sid, 'templar').bio).toBe('second');
    expect((await saveMyBio(agent, 'templar', 'x'.repeat(BIO_LENGTH))).text).toContain('Your bio was saved.');
    expect((await saveMyBio(agent, 'templar', '')).text).toContain('Your bio was saved.');
    expect(labState(sid, 'templar').bio).toBe('');
  });

  it('the moderator opens your profile directly (no Referer), and the bio runs every time it is viewed', async () => {
    const { agent, sid } = await freshSession();
    const lab = labState(sid, 'acolyte');
    await saveMyBio(agent, 'acolyte', PAYLOADS.acolyte(lab.marker.call));
    for (let i = 0; i < 2; i++) {
      await askModerator(agent, 'acolyte');
      // world.visits holds the visits of the last action: one, straight to the profile.
      expect(lab.world.visits.map((v) => v.hops.map((h) => [h.url, h.referer]))).toEqual([[['http://citadel.test/u/pilgrim', undefined]]]);
    }
    expect(stealsOn((await labPage(agent, LAB, 'acolyte')).text).length).toBe(2);
  });

  it('Restart drops the bio, the marker and the stolen key; the flag can be earned again', async () => {
    const { agent, sid } = await freshSession();
    await exploit(PAYLOADS.acolyte)(agent, 'acolyte');
    const before = labState(sid, 'acolyte');
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(303);
    const after = labState(sid, 'acolyte');
    expect(after).not.toBe(before);
    expect(after.bio).toBe('');
    expect((await signIn(agent, LAB, 'acolyte', before.key)).text).toContain('Wrong session key.');
    expect(markerOn((await labPage(agent, LAB, 'acolyte')).text)).toBe(after.marker.call);
    expect((await exploit(PAYLOADS.acolyte)(agent, 'acolyte')).text).toMatch(FLAG_RE);
  });

  it('the profile page is a twin: /u/pilgrim previews your card; the other members\' profiles exist; anyone else is 404', async () => {
    const { agent } = await freshSession();
    await saveMyBio(agent, 'inquisitor', 'I copy <i>psalms</i>.');
    const mine = await agent.get(`${LAB}/u/pilgrim?level=inquisitor`);
    expect(mine.status).toBe(200);
    expect(previewSrcdoc(mine.text).endsWith(`<body>${impl.for('inquisitor').renderBio('I copy <i>psalms</i>.')}</body></html>`)).toBe(true);
    expect((await agent.get(`${LAB}/u/citadel_admin?level=inquisitor`)).status).toBe(200);
    expect((await agent.get(`${LAB}/u/archivist?level=inquisitor`)).status).toBe(200);
    expect((await agent.get(`${LAB}/u/nobody?level=inquisitor`)).status).toBe(404);
    expect((await agent.get(`${LAB}/u/__proto__?level=inquisitor`)).status).toBe(404);
  });

  it('every level keeps ordinary words: a plain bio renders as itself', () => {
    for (const level of FP05.levels) expect(impl.for(level).renderBio('Walking since spring.'), level).toContain('>Walking since spring.</div>');
  });

  it('the lab declares what its bio can hold, at or above the measured worst case', () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
    const states = Array.from({ length: 6 }, (_, i) => labState(`w05-${i}-${randomBytes(4).toString('hex')}`, 'acolyte'));
    gc(); gc();
    const before = process.memoryUsage();
    for (const [i, s] of states.entries()) expect(saveBio(s, `${i}:`.padEnd(BIO_LENGTH, '✓')).ok).toBe(true); // the route's own path
    gc(); gc();
    const after = process.memoryUsage();
    const measured = ((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)) / states.length;
    expect(measured, `FP-05 measured ${(measured / 1024).toFixed(1)} KiB`).toBeLessThan(STATE_WEIGHT);
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
