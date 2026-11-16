// SC-04 Markdown renderer XSS: the exploit matrix, the view basics, the victim's button, the XSS proof (test kit), and
// SC-04's own cases: each level's flaw is a different Markdown feature (raw HTML / link scheme / image title), ordinary
// Markdown renders alike at every level, Divine's URL allowlist (no data: images, no javascript: in any spelling), the
// grammar's cost on a hostile note, the re-arm, and the note kept escaped in the lab chrome.
import type request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FLAG_RE, describeExploitMatrix, describeLabView, freshSession, type Agent } from '../../../../tests/helpers.js';
import type { Level } from '../../../core/levels.js';
import { xssOracle } from '../../../core/xss.js';
import { describeVictimAction, victimClient } from '../../_shared/victim-lab.testkit.js';
import { describeXssLab, labPage, previewSrcdoc, signIn, stolenKey, xssExploit } from '../../_shared/xss-lab.testkit.js';
import { SC04 } from './challenge.js'; // registers SC-04 before createApp() inside freshSession
import { NOTE_LENGTH, SESSION, labState, renderMarkdown } from './model.js';

const LAB = '/d/scriptorium/markdown-xss';
const victim = victimClient(LAB);
const noteLink = (md: string): string => `http://citadel.test/note?md=${encodeURIComponent(md)}`;
/** The player's move: send the librarian a shared-note link. */
const shareNote = (a: Agent, level: Level, md: string) => victim.sendLink(a, level, noteLink(md));
const exploit = xssExploit(LAB, shareNote);
type Script = (a: Agent, level: Level, sid: string) => Promise<request.Response>;
const M = "hvwa('0123456789abcdef')";

const PAYLOADS = {
  acolyte: (m: string) => `<script>${m}</script>`, // raw HTML passes through the renderer
  templar: (m: string) => `[the psalter](javascript:${m})`, // tags are stripped, but a link's target scheme is not checked
  inquisitor: (m: string) => `![seal](seal.png "Seal" onerror="${m}")`, // the image title runs to the last quote, unescaped
} as const;

describeExploitMatrix<Script>({
  challenge: SC04,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: exploit(PAYLOADS.acolyte), templar: exploit(PAYLOADS.templar), inquisitor: exploit(PAYLOADS.inquisitor) },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a note', input: (a, l) => labPage(a, LAB, l, `&md=${encodeURIComponent('# Psalms\n\nRead **daily**.')}`), expect: 'Preview of your note' },
    { name: 'a wrong key', input: (a, l) => signIn(a, LAB, l, 'nope'), expect: 'Wrong session key.' },
    {
      name: 'the librarian opens a plain note: nothing leaks',
      input: async (a, l) => { await shareNote(a, l, 'Read [the psalms](https://psalms.test/) *daily*.'); return labPage(a, LAB, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
  ],
  malformed: [],
  privileged: {
    name: 'the librarian\'s real session key',
    input: (a, l, sid) => signIn(a, LAB, l, labState(sid, l).key),
    expect: 'Signed in as the librarian.',
  },
});

describeLabView({
  challenge: SC04,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, [1, 2], {}],
  ok: (a, level, sid) => signIn(a, LAB, level, labState(sid, level).key),
  bad: (a, level) => signIn(a, LAB, level, 'nope'),
});

describeVictimAction({
  challenge: SC04,
  path: LAB,
  description: { en: 'opens the note link you send, while signed in', id: 'membuka tautan catatan yang Anda kirim, dalam keadaan masuk' },
});

describeXssLab({
  challenge: SC04,
  path: LAB,
  victimOf: labState,
  attack: shareNote,
  preview: (a, level, payload) => labPage(a, LAB, level, `&md=${encodeURIComponent(payload)}`),
  fragment: (level, payload) => renderMarkdown(level, payload),
  payloads: PAYLOADS,
  divineSanitizes: true, // a refused link keeps only its label: the marker in its target goes with it
});

describe('SC-04 Markdown lab', () => {
  it('ordinary Markdown renders alike at every level: headings, paragraphs, strong, emphasis, code, links, images', () => {
    const md = '# Psalms\n\nRead **daily** and *slowly*, see `psalm 23`.\n\n[The psalms](https://psalms.test/a?b=1) ![A seal](https://psalms.test/seal.png "The seal")';
    const want = '<h1>Psalms</h1><p>Read <strong>daily</strong> and <em>slowly</em>, see <code>psalm 23</code>.</p>'
      + '<p><a href="https://psalms.test/a?b=1">The psalms</a> <img src="https://psalms.test/seal.png" alt="A seal" title="The seal"></p>';
    for (const level of SC04.levels) expect(renderMarkdown(level, md), level).toBe(want);
  });

  it('each level fails on a different Markdown feature: raw HTML, then a link\'s scheme, then an image\'s title', () => {
    const fires = (level: Level, md: string): boolean => xssOracle(renderMarkdown(level, md), M).executes;
    expect(SC04.levels.map((l) => fires(l, PAYLOADS.acolyte(M)))).toEqual([true, false, false, false]);
    expect(SC04.levels.map((l) => fires(l, PAYLOADS.templar(M)))).toEqual([true, true, false, false]);
    expect(SC04.levels.map((l) => fires(l, PAYLOADS.inquisitor(M)))).toEqual([true, false, true, false]); // Templar escapes every attribute
    // Templar strips tags, and what is left is escaped: an unclosed tag does not get through either.
    expect(fires('templar', `<img src=x onerror=${M}`)).toBe(false);
  });

  it('inquisitor and divine check a link\'s scheme as the browser reads the URL (case, tabs, newlines, leading controls)', () => {
    for (const href of [`javascript:${M}`, `JaVaScRiPt:${M}`, `java\tscript:${M}`, `\u0001javascript:${M}`, `java%0Ascript:${M}`]) {
      for (const level of ['inquisitor', 'divine'] as const) {
        const v = xssOracle(renderMarkdown(level, `[x](${href})`), M);
        expect(v.executes, `${level} ${JSON.stringify(href)}`).toBe(false);
      }
    }
    expect(renderMarkdown('divine', '[mail](mailto:abbot@citadel.test)')).toBe('<p><a href="mailto:abbot@citadel.test">mail</a></p>');
    expect(renderMarkdown('divine', '[x](javascript:alert(1))')).toBe('<p>x</p>');
  });

  it('divine: images only from http(s) or a relative path (no data:), every attribute escaped', () => {
    expect(renderMarkdown('divine', '![x](data:image/svg+xml,<svg/onload=1>)')).not.toContain('<img');
    expect(renderMarkdown('divine', `![x](data:text/html,${M})`)).not.toContain('<img');
    expect(renderMarkdown('divine', '![a "b" <c>](seal.png "t" onerror="x")')).toBe('<p><img src="seal.png" alt="a &quot;b&quot; &lt;c&gt;" title="t&quot; onerror=&quot;x"></p>');
    const v = xssOracle(renderMarkdown('divine', PAYLOADS.inquisitor(M)), M);
    expect([v.executes, v.reachedMarker]).toEqual([false, true]);
  });

  it('a hostile note costs little: the inline grammar on the longest note stays fast at every level', () => {
    const notes = [
      '![a](b "'.repeat(NOTE_LENGTH / 8), '['.repeat(NOTE_LENGTH), '*'.repeat(NOTE_LENGTH), '`'.repeat(NOTE_LENGTH),
      '[x]('.repeat(NOTE_LENGTH / 4), `${'('.repeat(NOTE_LENGTH / 2)}${')'.repeat(NOTE_LENGTH / 2)}`,
    ];
    for (const level of SC04.levels) {
      const t0 = performance.now();
      for (const md of notes) renderMarkdown(level, md);
      expect(performance.now() - t0, level).toBeLessThan(250);
    }
  });

  it('the real route renders at most the note a link can carry', async () => {
    const { agent } = await freshSession();
    const long = `${'a'.repeat(NOTE_LENGTH)}TAIL`;
    const res = await labPage(agent, LAB, 'acolyte', `&md=${long}`);
    expect(res.status).toBe(200);
    expect(previewSrcdoc(res.text)).toContain(`<p>${'a'.repeat(NOTE_LENGTH)}</p>`);
    expect(res.text).not.toContain('TAIL');
  });

  it('a link that signs the librarian out never leaves the lab stuck: every action re-arms', async () => {
    const { agent, sid } = await freshSession();
    await victim.sendLink(agent, 'templar', 'http://citadel.test/logout');
    expect(labState(sid, 'templar').admin.cookies.get(SESSION)).toBeUndefined();
    expect((await exploit(PAYLOADS.templar)(agent, 'templar')).text).toMatch(FLAG_RE);
  });

  it('/note is the same page as the front page, for both browsers (twin paths)', async () => {
    const { agent, sid } = await freshSession();
    const res = await agent.get(`${LAB}/note?level=acolyte&md=${encodeURIComponent('**hi**')}`);
    expect(res.status).toBe(200);
    expect(previewSrcdoc(res.text)).toContain('<p><strong>hi</strong></p>');
    const { call } = labState(sid, 'acolyte').marker;
    await victim.sendLink(agent, 'acolyte', `http://citadel.test/?md=${encodeURIComponent(PAYLOADS.acolyte(call))}`);
    expect(stolenKey((await labPage(agent, LAB, 'acolyte')).text)).toBe(labState(sid, 'acolyte').key);
  });

  it('keeps the note escaped in the lab chrome and in its field; shows the share link as text', async () => {
    const { agent } = await freshSession();
    const md = '</textarea><b>x</b>';
    const res = await labPage(agent, LAB, 'acolyte', `&md=${encodeURIComponent(md)}`);
    expect(res.text).toContain('>&lt;/textarea&gt;&lt;b&gt;x&lt;/b&gt;</textarea>');
    expect(res.text).toContain(`<code data-testid="share-link">${noteLink(md)}</code>`);
    expect(res.text).toContain('<input type="hidden" name="level" value="acolyte">');
    expect(res.text).not.toContain('<b>x</b>');
    expect(previewSrcdoc(res.text)).toContain('<b>x</b>'); // raw only inside the frame
  });
});
