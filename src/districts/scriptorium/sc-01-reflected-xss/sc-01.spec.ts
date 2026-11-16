// SC-01 Reflected XSS (search): the exploit matrix, the view basics, the victim's button, the XSS proof (test kit), and
// SC-01's own cases: the Inquisitor attribute breakout both ways, Divine's route-scoped CSP that is NOT its fix, the
// re-arm after a sign-out link, and the query kept escaped in the lab chrome.
import type request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  FLAG_RE, describeExploitMatrix, describeLabView, freshSession, type Agent,
} from '../../../../tests/helpers.js';
import type { Level } from '../../../core/levels.js';
import { xssOracle } from '../../../core/xss.js';
import { describeVictimAction, victimClient } from '../../_shared/victim-lab.testkit.js';
import {
  describeXssLab, labPage, markerOn, previewSrcdoc, signIn, stolenKey, xssExploit,
} from '../../_shared/xss-lab.testkit.js';
import { SC01 } from './challenge.js'; // registers SC-01 before createApp() inside freshSession
import { SESSION, impl, labState } from './model.js';

const LAB = '/d/scriptorium/reflected-xss';
const victim = victimClient(LAB);
const searchLink = (q: string): string => `http://citadel.test/search?q=${encodeURIComponent(q)}`;
/** The player's move: send the librarian a search link for `q`. */
const sendSearch = (a: Agent, level: Level, q: string) => victim.sendLink(a, level, searchLink(q));
const exploit = xssExploit(LAB, sendSearch);
type Script = (a: Agent, level: Level, sid: string) => Promise<request.Response>;

const PAYLOADS = {
  acolyte: (m: string) => `<script>${m}</script>`, // an element: the query is concatenated raw
  templar: (m: string) => `<img src=x onerror=${m}>`, // the strip removes one spelling of one tag: a handler stands in
  inquisitor: (m: string) => `x autofocus onfocus=${m}`, // no angle brackets: the unquoted value ends at a space
} as const;

describeExploitMatrix<Script>({
  challenge: SC01,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: exploit(PAYLOADS.acolyte), templar: exploit(PAYLOADS.templar), inquisitor: exploit(PAYLOADS.inquisitor) },
  resisted: 'Wrong session key.',
  legit: [
    { name: 'a search', input: (a, l) => labPage(a, LAB, l, '&q=psalter'), expect: /No scrolls match/ },
    { name: 'a wrong key', input: (a, l) => signIn(a, LAB, l, 'nope'), expect: 'Wrong session key.' },
    {
      name: 'the librarian searches plain words: nothing leaks',
      input: async (a, l) => { await sendSearch(a, l, 'psalter'); return labPage(a, LAB, l); },
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
  challenge: SC01,
  path: LAB,
  account: /You are signed in as <code>pilgrim<\/code>/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, { intent: ['sign-in'], key: 'x' }, [1, 2], {}],
  ok: (a, level, sid) => signIn(a, LAB, level, labState(sid, level).key),
  bad: (a, level) => signIn(a, LAB, level, 'nope'),
});

describeVictimAction({
  challenge: SC01,
  path: LAB,
  description: { en: 'opens the search link you send, while signed in', id: 'membuka tautan pencarian yang Anda kirim, dalam keadaan masuk' },
});

describeXssLab({
  challenge: SC01,
  path: LAB,
  victimOf: labState,
  attack: sendSearch,
  preview: (a, level, payload) => labPage(a, LAB, level, `&q=${encodeURIComponent(payload)}`),
  fragment: (level, payload) => impl.for(level).results(payload),
  payloads: PAYLOADS,
});

describe('SC-01 search lab', () => {
  it('inquisitor: a handler the librarian triggers by hovering breaks out of the unquoted value too (no autofocus needed)', async () => {
    const { agent } = await freshSession();
    const res = await exploit((m) => `x onmouseover=${m}`)(agent, 'inquisitor');
    expect(res.text).toMatch(FLAG_RE);
  });

  it('every level reflects the query in the same two places: the results line and the refine field', () => {
    for (const level of SC01.levels) {
      const html = impl.for(level).results('psalter');
      expect(html, level).toContain('No scrolls match <b>psalter</b>.');
      expect(html, level).toMatch(/<input name="?q"? value="?psalter"?>/);
    }
  });

  it('divine sets its CSP on its own pages only (both browsers get it), and the CSP is not what stops the payload', async () => {
    const { agent, sid } = await freshSession();
    for (const level of SC01.levels) {
      const res = await labPage(agent, LAB, level, '&q=psalter');
      if (level === 'divine') expect(res.headers['content-security-policy'], level).toBe("script-src 'self'; object-src 'none'; base-uri 'none'");
      else expect(res.headers['content-security-policy'], level).toBeUndefined();
    }
    await sendSearch(agent, 'divine', 'psalter');
    // The librarian's page carries the same policy (the citadel twin)...
    const librarian = labState(sid, 'divine').admin;
    expect(librarian.verdicts.at(-1)?.fired).toBe(false);
    // ...but the oracle evaluates no script-src: Divine's fragment itself has no sink for any exploit.
    const { call } = labState(sid, 'divine').marker;
    for (const make of Object.values(PAYLOADS)) {
      const v = xssOracle(impl.for('divine').results(make(call)), call);
      expect([v.executes, v.reachedMarker], make(call)).toEqual([false, true]);
    }
    // A platform page in the same session carries no policy.
    expect((await agent.get('/')).headers['content-security-policy']).toBeUndefined();
  });

  it('a link that signs the librarian out never leaves the lab stuck: every action re-arms', async () => {
    const { agent, sid } = await freshSession();
    await victim.sendLink(agent, 'acolyte', 'http://citadel.test/logout');
    expect(labState(sid, 'acolyte').admin.cookies.get(SESSION)).toBeUndefined();
    const res = await exploit(PAYLOADS.acolyte)(agent, 'acolyte');
    expect(res.text).toMatch(FLAG_RE);
  });

  it('keeps the query escaped in the lab chrome and in its field, keeps the level in the search form, shows the share link as text', async () => {
    const { agent } = await freshSession();
    const q = '"><b>x</b>';
    const res = await labPage(agent, LAB, 'templar', `&q=${encodeURIComponent(q)}`);
    expect(res.text).toContain('value="&#34;&gt;&lt;b&gt;x&lt;/b&gt;"');
    expect(res.text).toContain('Results for <code>&#34;&gt;&lt;b&gt;x&lt;/b&gt;</code>');
    expect(res.text).toContain('<input type="hidden" name="level" value="templar">');
    expect(res.text).toContain(`<code data-testid="share-link">${searchLink(q).replace(/&/g, '&amp;')}</code>`);
    expect(res.text).not.toContain('<b>x</b>');
    expect(previewSrcdoc(res.text)).toContain('<b>x</b>'); // raw only inside the frame
  });

  it('/search is the same page as the front page, for both browsers (twin paths)', async () => {
    const { agent, sid } = await freshSession();
    const res = await agent.get(`${LAB}/search?level=acolyte&q=psalter`);
    expect(res.status).toBe(200);
    expect(previewSrcdoc(res.text)).toContain(impl.for('acolyte').results('psalter'));
    expect(markerOn(res.text)).toBe(labState(sid, 'acolyte').marker.call);
    const { call } = labState(sid, 'acolyte').marker;
    await victim.sendLink(agent, 'acolyte', `http://citadel.test/?q=${encodeURIComponent(PAYLOADS.acolyte(call))}`);
    expect(stolenKey((await labPage(agent, LAB, 'acolyte')).text)).toBe(labState(sid, 'acolyte').key);
  });

  it('a search with no query shows no results and no preview', async () => {
    const { agent } = await freshSession();
    const res = await labPage(agent, LAB, 'acolyte');
    expect(res.text).not.toContain('xss-preview');
    expect(res.text).not.toContain('Results for');
  });
});
