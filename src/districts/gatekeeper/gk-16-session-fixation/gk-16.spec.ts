// src/districts/gatekeeper/gk-16-session-fixation/gk-16.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, bare, describeExploitMatrix, freshSession, panelOf, setCookieValue, unescapeHtml, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import {
  describeLabCookies, describeSignInView, describeVictimAction, expectInLab, victimClient,
} from '../../_shared/victim-lab.testkit.js';
import { describeCurlExample } from '../_shared/pilgrim-lab.testkit.js';
import { GK16 } from './challenge.js'; // registers GK-16 before createApp() inside freshSession
import { cookieName, labState } from './model.js';

const LAB = '/d/gatekeeper/session-fixation';
const ADMIN = 'citadel_admin';
const CHOSEN = 'chosen-by-pilgrim-1';

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

// --- The player's moves --------------------------------------------------------------------------------------------
const home = (a: Agent, l: Level, extra = '') => a.get(`${LAB}?level=${l}&lang=en${extra}`);
const signIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}?level=${l}`).type('form').send({ username, password });
const { sendLink } = victimClient(LAB);
const adminPage = (a: Agent, l: Level) => a.get(`${LAB}/admin?level=${l}`);
/** "Your session: <code>…</code>" on the page. */
const sessionOn = (html: string): string | undefined => /Your session: <code>([^<]*)<\/code>/.exec(html)?.[1];
/** The link the page offers to continue this session elsewhere, as a citadel.test URL (unescaped). */
const shareLinkOn = (html: string): string | undefined => {
  const m = /data-testid="share-link"[^>]*><code>([^<]*)<\/code>/.exec(html)?.[1];
  return m === undefined ? undefined : unescapeHtml(m);
};
const adminPassword = (sid: string, l: Level): string => labState(sid, l).adminPassword;

// --- The exploits ----------------------------------------------------------------------------------------------------
// Acolyte: any ?sid= is adopted as the session and login never rotates it. Pick an id, make the admin sign in on it.
const acolyteExploit: Script = async (a, l) => {
  await sendLink(a, l, `http://citadel.test/?sid=${CHOSEN}`);
  await home(a, l, `&sid=${CHOSEN}`); // the same trick sets it in your own browser
  return adminPage(a, l);
};

// Templar: ?sid= must be an id the server issued. Get one (your own visit does), make the admin sign in on it.
const templarExploit: Script = async (a, l) => {
  const mine = sessionOn((await home(a, l)).text) ?? 'none';
  await sendLink(a, l, `http://citadel.test/?sid=${mine}`);
  return adminPage(a, l);
};

// Inquisitor: no URL ids, but a resume link sets your session in another browser, and after login the old id stays
// valid for a 60-second grace period. Send the admin your resume link, then use your own (old) id at once.
const inquisitorExploit: Script = async (a, l) => {
  const link = shareLinkOn((await home(a, l)).text) ?? 'http://citadel.test/resume?token=none';
  await sendLink(a, l, link);
  return adminPage(a, l);
};

describeExploitMatrix<Script>({
  challenge: GK16,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Admin only',
  resistedStatus: 403,
  legit: [
    { name: 'own account pilgrim/pilgrim', input: (a, l) => signIn(a, l, 'pilgrim', 'pilgrim'), expect: 'Signed in as pilgrim.' },
    {
      name: 'the admin signs in from a plain citadel link',
      input: async (a, l) => { await sendLink(a, l, 'http://citadel.test/'); return home(a, l); },
      expect: 'The admin signed in on the page your link opened.',
    },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: {
    name: 'the real admin password',
    input: async (a, l, sid) => { await signIn(a, l, ADMIN, adminPassword(sid, l)); return adminPage(a, l); },
    expect: /Citadel admin console/,
  },
});

describeSignInView({ challenge: GK16, path: LAB });
describeVictimAction({
  challenge: GK16, path: LAB,
  description: {
    en: 'opens the link you send in a fresh browser, then signs in on the citadel sign-in page it lands on',
    id: 'membuka tautan yang Anda kirim di peramban baru, lalu masuk di halaman masuk citadel yang terbuka',
  },
  label: { en: 'Send your session link to the admin', id: 'Kirim tautan sesi ke admin' },
});
describeLabCookies({ challenge: GK16, path: LAB, cookies: [{ name: cookieName, set: (agent, level, base) => agent.get(`${base}?level=${level}`) }] });

describeCurlExample({
  challenge: GK16, path: LAB,
  curl: (level) => ({ path: '/admin', cookies: [`${cookieName(level)}=<session id>`] }),
});

describe('GK-16 how each level picks the session', () => {
  it('acolyte: any well-formed ?sid= becomes your session; odd ones are ignored', async () => {
    const { agent } = await freshSession();
    const res = await home(agent, 'acolyte', `&sid=${CHOSEN}`);
    expect(setCookieValue(res, cookieName('acolyte'))).toBe(CHOSEN);
    expect(sessionOn(res.text)).toBe(CHOSEN);
    for (const odd of ['%3Cscript%3E', 'a'.repeat(65), '', 'a%20b']) {
      const other = await home(agent, 'acolyte', `&sid=${odd}`);
      expect(sessionOn(other.text), odd).toBe(CHOSEN); // the cookie stays
    }
  });

  it('templar: ?sid= is adopted only when the server issued it', async () => {
    const a = await freshSession();
    const issued = sessionOn((await home(a.agent, 'templar')).text)!;
    const b = await freshSession(a.app);
    const invented = await home(b.agent, 'templar', `&sid=${CHOSEN}`);
    expect(sessionOn(invented.text)).not.toBe(CHOSEN);
    expect(sessionOn(invented.text)).toMatch(/^[0-9a-f]{32}$/);
    const c = await freshSession(a.app);
    // Another player's id means nothing here (each player's lab is its own) ...
    expect(sessionOn((await home(c.agent, 'templar', `&sid=${issued}`)).text)).not.toBe(issued);
    // ... but an id your lab issued is adopted by any browser that opens it (no lab cookie of its own here).
    const mine = sessionOn((await home(b.agent, 'templar')).text)!;
    const again = await bare(b.app, b.sid).get(`${LAB}?level=templar&lang=en&sid=${mine}`);
    expect(setCookieValue(again, cookieName('templar'))).toBe(mine);
  });

  it('acolyte and templar never rotate the id at login', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const { agent } = await freshSession();
      const before = sessionOn((await home(agent, level)).text);
      const res = await signIn(agent, level, 'pilgrim', 'pilgrim');
      expect(setCookieValue(res, cookieName(level)), level).toBeUndefined();
      expect(sessionOn(res.text), level).toBe(before);
    }
  });

  it('inquisitor and divine ignore ?sid= and rotate the id at login', async () => {
    for (const level of ['inquisitor', 'divine'] as const) {
      const { agent, app, sid } = await freshSession();
      const before = sessionOn((await home(agent, level)).text)!;
      expect(sessionOn((await home(agent, level, `&sid=${CHOSEN}`)).text), level).toBe(before);
      // Even an id the server really issued is ignored in a URL: another browser of yours (no lab cookie) opening it
      // gets a session of its own.
      const other = await bare(app, sid).get(`${LAB}?level=${level}&lang=en&sid=${before}`);
      expect(sessionOn(other.text), level).toMatch(/^[0-9a-f]{32}$/);
      expect(sessionOn(other.text), level).not.toBe(before);
      expect(setCookieValue(other, cookieName(level)), level).not.toBe(before);
      const res = await signIn(agent, level, 'pilgrim', 'pilgrim');
      const after = setCookieValue(res, cookieName(level));
      expect(after, level).toMatch(/^[0-9a-f]{32}$/);
      expect(after, level).not.toBe(before);
    }
  });

  it('inquisitor: the pre-login id stays an alias of the signed-in session for 60 s of the lab clock', async () => {
    const { agent, sid, app } = await freshSession();
    const world = labState(sid, 'inquisitor').world;
    const t0 = Date.UTC(2026, 10, 16, 10, 0, 0);
    world.now = () => t0;
    const old = sessionOn((await home(agent, 'inquisitor')).text)!;
    await signIn(agent, 'inquisitor', 'pilgrim', 'pilgrim');
    const asOld = () => bare(app, sid, `${cookieName('inquisitor')}=${old}`).get(`${LAB}?level=inquisitor&lang=en`);
    world.now = () => t0 + 59_999;
    expect((await asOld()).text).toContain('Signed in as pilgrim');
    world.now = () => t0 + 60_000;
    expect((await asOld()).text).not.toContain('Signed in as pilgrim');
  });

  it('inquisitor: a resume link sets the session in another browser; the other levels have none', async () => {
    const a = await freshSession();
    const page = await home(a.agent, 'inquisitor');
    const mine = sessionOn(page.text)!;
    const link = shareLinkOn(page.text)!;
    expect(link).toMatch(/^http:\/\/citadel\.test\/resume\?token=[0-9a-f]{32}$/);
    const b = await freshSession(a.app);
    // Another browser of the same player (same hvwa_sid, no lab cookie) follows the lab twin of the link.
    const res = await bare(a.app, a.sid).get(`${LAB}/resume?token=${new URL(link).searchParams.get('token')}&level=inquisitor`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${LAB}?level=inquisitor`);
    expect(setCookieValue(res, cookieName('inquisitor'))).toBe(mine);
    expect((await b.agent.get(`${LAB}/resume?token=nope&level=inquisitor`)).status).toBe(404);
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      const { agent } = await freshSession();
      expect((await agent.get(`${LAB}/resume?token=x&level=${level}`)).status, level).toBe(404);
    }
    const divinePage = await home(a.agent, 'divine');
    expect(shareLinkOn(divinePage.text)).toBeUndefined();
  });

  it('acolyte and templar offer a session link with the id in the URL', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const { agent } = await freshSession();
      const page = await home(agent, level);
      expect(shareLinkOn(page.text), level).toBe(`http://citadel.test/?sid=${sessionOn(page.text)}`);
    }
  });

  it('divine: the pre-login id is dead the moment you sign in', async () => {
    const { agent, sid, app } = await freshSession();
    const old = sessionOn((await home(agent, 'divine')).text)!;
    await signIn(agent, 'divine', 'pilgrim', 'pilgrim');
    const res = await bare(app, sid, `${cookieName('divine')}=${old}`).get(`${LAB}?level=divine&lang=en`);
    expect(res.text).toContain('Not signed in.');
    expect(sessionOn(res.text)).not.toBe(old);
  });
});

describe('GK-16 the victim flow end to end', () => {
  it('acolyte: the admin opens your link and signs in on your chosen id; that id opens the admin console', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', `http://citadel.test/?sid=${CHOSEN}`);
    const lab = labState(sid, 'acolyte');
    expect(lab.admin.cookies.get(cookieName('acolyte'))).toBe(CHOSEN);
    expect(lab.world.visits.map((v) => v.outcome)).toEqual(['page', 'page']); // the link, then the sign-in form
    expect(lab.world.visits[1].hops[0]).toMatchObject({ method: 'POST', url: `http://citadel.test/?sid=${CHOSEN}`, referer: `http://citadel.test/?sid=${CHOSEN}` });
    const page = await home(agent, 'acolyte');
    expect(panelOf(page.text)).toContain('The admin signed in on the page your link opened.');
    expect(panelOf(page.text)).toContain('Visit 2: 1 request(s); ended on a citadel.test page (HTTP 200).');
    expect((await adminPage(agent, 'acolyte')).status).toBe(403); // your own browser is still on its own id ...
    expect((await home(agent, 'acolyte', `&sid=${CHOSEN}`)).status).toBe(200);
    expect((await adminPage(agent, 'acolyte')).text).toMatch(FLAG_RE); // ... until you adopt the fixed one
  });

  it('inquisitor: the grace window closes after 60 s', async () => {
    const { agent, sid } = await freshSession();
    const world = labState(sid, 'inquisitor').world;
    const t0 = Date.UTC(2026, 10, 16, 10, 0, 0);
    world.now = () => t0;
    const link = shareLinkOn((await home(agent, 'inquisitor')).text)!;
    await sendLink(agent, 'inquisitor', link);
    world.now = () => t0 + 61_000;
    const late = await adminPage(agent, 'inquisitor');
    expect(late.status).toBe(403);
    expect(late.text).not.toMatch(FLAG_RE);
  });

  it('a link that does not end on the citadel sign-in page: the admin does not sign in, and the note says why', async () => {
    const { agent, sid } = await freshSession();
    for (const url of ['http://attacker.test/x', 'http://citadel.test/admin', 'http://citadel.test/nope', 'javascript:alert(1)']) {
      await sendLink(agent, 'acolyte', url);
      const en = panelOf((await home(agent, 'acolyte')).text);
      expect(en, url).toContain('The admin&#39;s browser ended on a page that is not the citadel sign-in page, so the admin did not sign in.');
      expect(labState(sid, 'acolyte').world.visits, url).toHaveLength(1);
    }
    const id = panelOf((await agent.get(`${LAB}?level=acolyte&lang=id`)).text);
    expect(id).toContain('Peramban admin berakhir di halaman yang bukan halaman masuk citadel, jadi admin tidak masuk.');
    expect(attackerHits((await home(agent, 'acolyte')).text).map((h) => h.url)).toEqual(['http://attacker.test/x']);
  });

  it('every action starts the admin in a fresh browser: an id fixed by an earlier link does not carry over', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', `http://citadel.test/?sid=${CHOSEN}`);
    await sendLink(agent, 'acolyte', 'http://citadel.test/');
    const jar = labState(sid, 'acolyte').admin.cookies.get(cookieName('acolyte'));
    expect(jar).toBeDefined();
    expect(jar).not.toBe(CHOSEN);
  });

  it('divine: the admin\'s session id never reaches the page', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'divine', 'http://citadel.test/');
    const adminSid = labState(sid, 'divine').admin.cookies.get(cookieName('divine'))!;
    expect(adminSid).toMatch(/^[0-9a-f]{32}$/);
    const page = await home(agent, 'divine');
    expect(page.text).not.toContain(adminSid);
    expect(page.text).not.toContain(adminPassword(sid, 'divine'));
  });

  it('isolates players and levels: a fixed id works only in the lab where the admin signed in on it', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    await sendLink(a.agent, 'acolyte', `http://citadel.test/?sid=${CHOSEN}`);
    expect((await bare(a.app, b.sid, `${cookieName('acolyte')}=${CHOSEN}`).get(`${LAB}/admin?level=acolyte`)).status).toBe(403);
    expect((await bare(a.app, a.sid, `${cookieName('templar')}=${CHOSEN}`).get(`${LAB}/admin?level=templar`)).status).toBe(403);
    const own = await bare(a.app, a.sid, `${cookieName('acolyte')}=${CHOSEN}`).get(`${LAB}/admin?level=acolyte`);
    expect(own.status).toBe(200);
    expect(own.text).toMatch(FLAG_RE);
  });
});

describe('GK-16 the lab state', () => {
  it('the admin page never creates a session, with or without a cookie', async () => {
    const { agent, sid, app } = await freshSession();
    await home(agent, 'templar');
    const sessions = labState(sid, 'templar').sessions;
    const before = sessions.size;
    for (let i = 0; i < 10; i++) await bare(app, sid, `${cookieName('templar')}=guess${i}`).get(`${LAB}/admin?level=templar`);
    await bare(app, sid).get(`${LAB}/admin?level=templar`);
    expect(sessions.size).toBe(before);
  });

  it('session, alias and resume maps stay bounded however many ids you push', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 130; i++) await home(agent, 'acolyte', `&sid=flood-${i}`);
    expect(labState(sid, 'acolyte').sessions.size).toBeLessThanOrEqual(100);
    const inq = await freshSession();
    for (let i = 0; i < 60; i++) {
      await bare(inq.app, inq.sid).get(`${LAB}?level=inquisitor&lang=en`); // a new browser each time: a new session
      await bare(inq.app, inq.sid).post(`${LAB}?level=inquisitor`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
    }
    const state = labState(inq.sid, 'inquisitor');
    expect(state.sessions.size).toBeLessThanOrEqual(100);
    expect(state.aliases.size).toBeLessThanOrEqual(100);
    expect(state.resumes.size).toBeLessThanOrEqual(100);
  });

  // The session cookie's names, path and HttpOnly: describeLabCookies above.
  it('a wrong password does not sign in, and the admin cannot be signed in to through guesses', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const creds of [{ username: 'pilgrim', password: 'nope' }, { username: ADMIN, password: 'pilgrim' }, { username: ADMIN, password: '' }]) {
        const res = await signIn(agent, level, creds.username, creds.password);
        expect(res.text, level).toContain('Invalid username or password.');
      }
      expect((await adminPage(agent, level)).status, level).toBe(403);
    }
  });
});

describe('GK-16 your real browser never leaves the lab (sendSimRedirect)', () => {
  it('the resume route answers 302 into the lab at the served level, never a bare path or another host', async () => {
    const { agent } = await freshSession();
    const link = shareLinkOn((await home(agent, 'inquisitor')).text)!;
    const res = await agent.get(`${LAB}/resume?level=inquisitor&token=${new URL(link).searchParams.get('token')}`);
    expect(res.status).toBe(302);
    expect(expectInLab(res, LAB, 'inquisitor')).toBe(`${LAB}?level=inquisitor`);
  });
});

describe('GK-16 lab view specifics', () => {
  it('shows your session, who it is signed in as, and links the admin page by its absolute path', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'acolyte');
    expect(sessionOn(page.text)).toMatch(/^[0-9a-f]{32}$/);
    expect(page.text).toContain('Not signed in.');
    expect(page.text).toContain(`href="${LAB}/admin?level=acolyte"`);
    expect(page.text).toContain(cookieName('acolyte'));
    expect(page.text).toMatch(/devtools[\s\S]*-b/);
  });

  it('the session link shown is escaped and opens in the lab', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'templar');
    const mine = sessionOn(page.text)!;
    expect(page.text).toContain(`href="${LAB}?sid=${mine}&amp;level=templar"`);
  });
});
