// src/districts/gatekeeper/gk-11-oauth-missing-state/gk-11.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, describeExploitMatrix, describeLabView, freshSession, panelOf, setCookieHeader, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK11 } from './challenge.js'; // registers GK-11 before createApp() inside freshSession
import * as divine from './levels/divine.js';
import { clientCookie, labState, pidCookie } from './model.js';

const LAB = '/d/gatekeeper/oauth-missing-state';
const ADMIN = 'citadel_admin';
const LINK_CB = 'http://citadel.test/link/callback';

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

// --- The player's moves --------------------------------------------------------------------------------------------
const home = (a: Agent, l: Level, lang = 'en') => a.get(`${LAB}?level=${l}&lang=${lang}`);
const citadelSignIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}?level=${l}`).type('form').send({ username, password });
const pidSignIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}/idp?level=${l}`).type('form').send({ username, password });
const sendLink = (a: Agent, l: Level, url: string) => a.post(`${LAB}/victim/send-link?level=${l}`).type('form').send({ url });
/** Your real browser: follow redirects (sendSimRedirect keeps them in the lab); the last answer and its URL. */
async function browse(a: Agent, url: string): Promise<{ res: request.Response; at: string }> {
  let at = url;
  let res = await a.get(at);
  for (let i = 0; i < 6 && res.status >= 300 && res.status < 400; i++) {
    at = String(res.headers.location);
    res = await a.get(at);
  }
  return { res, at };
}
const signInWithPilgrimId = async (a: Agent, l: Level) => (await browse(a, `${LAB}/login?level=${l}`)).res;
const directAuthorize = (l: Level, state: string) =>
  `${LAB}/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent(LINK_CB)}&state=${state}&level=${l}`;

/**
 * A fresh code for YOUR Pilgrim-ID that nobody has used: sign in to Pilgrim-ID, stay signed out of Citadel, and run the
 * link flow ('client': Citadel's own "Link your Pilgrim-ID"; 'direct': an authorize request you write yourself). The
 * callback refuses to link a signed-out browser, so the code (and state) in its URL are still unused.
 */
async function ownLinkCode(a: Agent, l: Level, via: 'client' | 'direct'): Promise<{ code: string; state: string | null }> {
  await pidSignIn(a, l, 'pilgrim', 'pilgrim');
  const { at } = await browse(a, via === 'client' ? `${LAB}/link?level=${l}` : directAuthorize(l, 'made-up-state'));
  const u = new URL(at, 'http://lab.invalid');
  return { code: u.searchParams.get('code') ?? 'none', state: u.searchParams.get('state') };
}
const linkCallback = (code: string, state?: string | null): string =>
  `${LINK_CB}?code=${code}${state === undefined || state === null ? '' : `&state=${encodeURIComponent(state)}`}`;

// --- The exploits ----------------------------------------------------------------------------------------------------
// Acolyte: the client never looks at state. Any callback URL with your code links your Pilgrim-ID to whoever opens it.
const acolyteExploit: Script = async (a, l) => {
  const { code } = await ownLinkCode(a, l, 'direct');
  await sendLink(a, l, linkCallback(code, 'made-up-state'));
  return signInWithPilgrimId(a, l);
};
// Templar: state is checked only when it is there. Leave it out.
const templarExploit: Script = async (a, l) => {
  const { code } = await ownLinkCode(a, l, 'client');
  await sendLink(a, l, linkCallback(code));
  return signInWithPilgrimId(a, l);
};
// Inquisitor: state must be one Citadel issued, but any browser's will do. Send your own.
const inquisitorExploit: Script = async (a, l) => {
  const { code, state } = await ownLinkCode(a, l, 'client');
  await sendLink(a, l, linkCallback(code, state ?? 'none'));
  return signInWithPilgrimId(a, l);
};

describeExploitMatrix<Script>({
  challenge: GK11,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'No Citadel account is linked to your Pilgrim-ID',
  legit: [
    { name: 'own Citadel account pilgrim/pilgrim', input: (a, l) => citadelSignIn(a, l, 'pilgrim', 'pilgrim'), expect: 'Welcome, pilgrim' },
    {
      name: 'link your own Pilgrim-ID, then sign in with it',
      input: async (a, l) => {
        await citadelSignIn(a, l, 'pilgrim', 'pilgrim');
        await pidSignIn(a, l, 'pilgrim', 'pilgrim');
        await browse(a, `${LAB}/link?level=${l}`);
        await browse(a, `${LAB}/logout?level=${l}`);
        return signInWithPilgrimId(a, l);
      },
      expect: 'Welcome, pilgrim',
    },
    {
      name: 'the admin opens a harmless citadel link',
      input: async (a, l) => { await sendLink(a, l, 'http://citadel.test/'); return home(a, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)/,
    },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: {
    name: 'the admin\'s own Pilgrim-ID',
    input: async (a, l, sid) => { await pidSignIn(a, l, ADMIN, labState(sid, l).adminPidPassword); return signInWithPilgrimId(a, l); },
    expect: /Welcome, citadel_admin/,
  },
});

describeLabView({
  challenge: GK11,
  path: LAB,
  account: /pilgrim<\/code> \/ <code>pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level) => citadelSignIn(agent, level, 'pilgrim', 'pilgrim'),
  bad: (agent, level) => citadelSignIn(agent, level, 'pilgrim', 'nope'),
});

describe('GK-11 what each level does with state', () => {
  it('the link flow: no state at Acolyte, a state at the other levels, PKCE at Divine only', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      await home(agent, level);
      const start = await agent.get(`${LAB}/link?level=${level}`);
      expect(start.status, level).toBe(302);
      const q = new URL(String(start.headers.location), 'http://lab.invalid').searchParams;
      expect(q.get('redirect_uri'), level).toBe(LINK_CB);
      expect(q.has('state'), level).toBe(level !== 'acolyte');
      expect(q.get('code_challenge_method'), level).toBe(level === 'divine' ? 'S256' : null);
    }
  });

  type Case = [Level, 'none' | 'made-up' | 'yours', 'linked' | 'refused'];
  const cases: Case[] = [
    ['acolyte', 'none', 'linked'], ['acolyte', 'made-up', 'linked'], ['acolyte', 'yours', 'linked'],
    ['templar', 'none', 'linked'], ['templar', 'made-up', 'refused'], ['templar', 'yours', 'refused'],
    ['inquisitor', 'none', 'refused'], ['inquisitor', 'made-up', 'refused'], ['inquisitor', 'yours', 'linked'],
    ['divine', 'none', 'refused'], ['divine', 'made-up', 'refused'], ['divine', 'yours', 'refused'],
  ];
  it.each(cases)('%s: the admin opens your link callback with %s state: %s', async (level, which, outcome) => {
    const { agent, sid } = await freshSession();
    const { code, state } = await ownLinkCode(agent, level, 'client');
    await sendLink(agent, level, linkCallback(code, which === 'none' ? undefined : which === 'made-up' ? 'made-up-state' : state));
    const page = labState(sid, level).world.visits.at(-1)?.page;
    if (outcome === 'linked') {
      expect(labState(sid, level).links.get('pilgrim')).toBe(ADMIN);
      expect(page?.body).toContain('is now linked to your Citadel account (citadel_admin)');
    } else {
      expect(labState(sid, level).links.get('pilgrim')).toBeUndefined();
      expect(page?.status).toBe(400);
      expect(page?.body).toContain('Linking failed');
    }
  });

  it('a callback in a browser signed out of Citadel uses up neither the code nor the state', async () => {
    for (const level of LEVELS) {
      const { agent, sid } = await freshSession();
      const { code, state } = await ownLinkCode(agent, level, 'client');
      const lab = labState(sid, level);
      expect(lab.codes.get(code)?.used, level).toBe(false);
      expect(state === null, `${level}: only Acolyte sends no state`).toBe(level === 'acolyte');
      expect(state === null || lab.flows.has(state), `${level}: the state is still unused`).toBe(true);
      const again = await agent.get(`${LAB}/link/callback?code=${code}${state === null ? '' : `&state=${state}`}&level=${level}`);
      expect(again.text, level).toContain('Sign in to Citadel to finish linking. Nothing was linked.');
    }
  });

  it('divine: the state is used once, and a code without the flow\'s PKCE challenge does not complete it', async () => {
    const { agent, sid } = await freshSession();
    await citadelSignIn(agent, 'divine', 'pilgrim', 'pilgrim');
    await pidSignIn(agent, 'divine', 'pilgrim', 'pilgrim');
    // Start a link flow but present a code you got without its challenge (a direct authorize request).
    const start = await agent.get(`${LAB}/link?level=divine`);
    const state = new URL(String(start.headers.location), 'http://lab.invalid').searchParams.get('state') ?? '';
    const direct = await agent.get(directAuthorize('divine', state));
    const code = new URL(String(direct.headers.location), 'http://lab.invalid').searchParams.get('code') ?? '';
    const res = await agent.get(`${LAB}/link/callback?code=${code}&state=${state}&level=divine`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Linking failed');
    expect(labState(sid, 'divine').links.get('pilgrim')).toBeUndefined();
    // The honest flow works, once.
    const { at } = await browse(agent, `${LAB}/link?level=divine`);
    expect(labState(sid, 'divine').links.get('pilgrim')).toBe('pilgrim');
    const replay = await agent.get(at);
    expect(replay.text).toContain('Linking failed');
  });
});

describe('GK-11 divine: the state check (levels/divine.ts acceptState, called directly)', () => {
  // Directly on the level function: over HTTP a replayed callback also fails on its used-up code, which masks a
  // state that is not single-use.
  const fresh = async () => labState((await freshSession()).sid, 'divine');

  it('the session that started a flow finishes it once: the same state a second time fails', async () => {
    const lab = await fresh();
    const st = lab.newState({ session: 's1', purpose: 'link', verifier: 'v' });
    expect(divine.acceptState(lab, st, 's1', 'link')).toEqual({ ok: true, flow: { session: 's1', purpose: 'link', verifier: 'v' } });
    expect(divine.acceptState(lab, st, 's1', 'link')).toEqual({ ok: false });
  });

  it('a link state does not finish a sign-in (a link state at /callback), and it is used up', async () => {
    const lab = await fresh();
    const st = lab.newState({ session: 's1', purpose: 'link' });
    expect(divine.acceptState(lab, st, 's1', 'login')).toEqual({ ok: false });
    expect(divine.acceptState(lab, st, 's1', 'link')).toEqual({ ok: false });
  });

  it('another session cannot finish it, and no state finishes nothing', async () => {
    const lab = await fresh();
    const st = lab.newState({ session: 's1', purpose: 'link' });
    expect(divine.acceptState(lab, st, 's2', 'link')).toEqual({ ok: false });
    expect(divine.acceptState(lab, null, 's1', 'link')).toEqual({ ok: false });
    expect(divine.acceptState(lab, 'never-issued', 's1', 'link')).toEqual({ ok: false });
  });

  it('over HTTP: the state of your own link flow does not complete your own sign-in', async () => {
    const { agent, sid } = await freshSession();
    await pidSignIn(agent, 'divine', 'pilgrim', 'pilgrim');
    const link = await agent.get(`${LAB}/link?level=divine`);
    const linkState = new URL(String(link.headers.location), 'http://lab.invalid').searchParams.get('state') ?? '';
    const login = await agent.get(`${LAB}/login?level=divine`);
    const authorized = await agent.get(String(login.headers.location)); // Pilgrim-ID's answer, mapped into the lab
    const callback = new URL(String(authorized.headers.location), 'http://lab.invalid');
    expect(callback.pathname).toBe(`${LAB}/callback`);
    callback.searchParams.set('state', linkState);
    const res = await agent.get(`${callback.pathname}${callback.search}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in failed: the state does not belong to a sign-in this browser started.');
    expect(labState(sid, 'divine').flows.has(linkState)).toBe(false);
  });
});

describe('GK-11 the victim flow end to end', () => {
  it('inquisitor: the admin completes your link, and signing in with your Pilgrim-ID lands in the admin\'s account', async () => {
    const { agent, sid } = await freshSession();
    const { code, state } = await ownLinkCode(agent, 'inquisitor', 'client');
    await sendLink(agent, 'inquisitor', linkCallback(code, state));
    const page = await home(agent, 'inquisitor');
    expect(panelOf(page.text)).toContain('Visit 1: 1 request(s); ended on a citadel.test page (HTTP 200).');
    expect(attackerHits(page.text)).toEqual([]); // nothing needs your server here
    expect(labState(sid, 'inquisitor').links.get('pilgrim')).toBe(ADMIN);
    const res = await signInWithPilgrimId(agent, 'inquisitor');
    expect(res.text).toContain('Welcome, citadel_admin (role: admin).');
    expect(res.text).toMatch(FLAG_RE);
    expect((await home(agent, 'inquisitor')).text).toMatch(FLAG_RE); // signed in to Citadel as the admin
  });

  it('the admin is signed in to Citadel at the start of every action, even after a link signed the admin out', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', 'http://citadel.test/logout');
    expect(labState(sid, 'acolyte').admin.cookies.get(clientCookie('acolyte'))).not.toBe(labState(sid, 'acolyte').adminSession);
    expect((await acolyteExploit(agent, 'acolyte', sid)).text).toMatch(FLAG_RE);
  });

  it('the admin\'s Citadel session never reaches the page', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', 'http://citadel.test/');
    expect((await home(agent, 'acolyte')).text).not.toContain(labState(sid, 'acolyte').adminSession);
  });

  it('isolates players and levels: your code and state mean nothing in another lab', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    const { code, state } = await ownLinkCode(a.agent, 'inquisitor', 'client');
    await sendLink(b.agent, 'inquisitor', linkCallback(code, state));
    expect(labState(b.sid, 'inquisitor').links.get('pilgrim')).toBeUndefined();
    await sendLink(a.agent, 'templar', linkCallback(code));
    expect(labState(a.sid, 'templar').links.get('pilgrim')).toBeUndefined();
    await sendLink(a.agent, 'inquisitor', linkCallback(code, state));
    expect(labState(a.sid, 'inquisitor').links.get('pilgrim')).toBe(ADMIN);
  });
});

describe('GK-11 Pilgrim-ID itself is sound', () => {
  it('a code goes only to a registered redirect URI, and is redeemed once', async () => {
    const { agent, sid } = await freshSession();
    await pidSignIn(agent, 'acolyte', 'pilgrim', 'pilgrim');
    const away = await agent.get(`${LAB}/idp/authorize?response_type=code&client_id=citadel&redirect_uri=${encodeURIComponent('http://attacker.test/')}&level=acolyte`);
    expect(away.status).toBe(400);
    expect(away.text).toContain('Pilgrim-ID: this redirect_uri is not registered for the client.');
    expect(labState(sid, 'acolyte').codes.size).toBe(0);
    await citadelSignIn(agent, 'acolyte', 'pilgrim', 'pilgrim');
    const { at } = await browse(agent, `${LAB}/link?level=acolyte`);
    expect(labState(sid, 'acolyte').links.get('pilgrim')).toBe('pilgrim');
    expect((await agent.get(at)).text).toContain('Linking failed');
  });

  it('a code for the link callback does not sign anyone in at the sign-in callback', async () => {
    const { agent } = await freshSession();
    const { code } = await ownLinkCode(agent, 'acolyte', 'direct');
    const res = await agent.get(`${LAB}/callback?code=${code}&level=acolyte`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in failed');
  });
});

describe('GK-11 your real browser never leaves the lab (sendSimRedirect)', () => {
  it('every hop of linking and signing in is a Location inside the lab, at the served level', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      await pidSignIn(agent, level, 'pilgrim', 'pilgrim');
      for (const start of ['/link', '/login']) {
        const first = await agent.get(`${LAB}${start}?level=${level}`);
        expect(first.status, `${level} ${start}`).toBe(302);
        expect(String(first.headers.location), `${level} ${start}`).toMatch(new RegExp(`^${LAB}/idp/authorize\\?.*&level=${level}$`));
        const second = await agent.get(String(first.headers.location));
        expect(second.status, `${level} ${start}`).toBe(302);
        expect(String(second.headers.location), `${level} ${start}`).toMatch(new RegExp(`^${LAB}/(link/)?callback\\?code=[0-9a-f]{32}.*&level=${level}$`));
      }
      const out = await agent.get(`${LAB}/logout?level=${level}`);
      expect(out.status, level).toBe(302);
      expect(out.headers.location, level).toBe(`${LAB}?level=${level}`);
    }
  });
});

describe('GK-11 the lab state', () => {
  it('cookies are named per level, on the canonical lab path, HttpOnly', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const c = setCookieHeader(await agent.get(`${LAB.toUpperCase()}?level=${level}`), clientCookie(level));
      expect(c, level).toContain(`Path=${LAB}`);
      expect(c, level).toMatch(/HttpOnly/i);
      const p = setCookieHeader(await agent.post(`${LAB.toUpperCase()}/IDP?level=${level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' }), pidCookie(level));
      expect(p, level).toContain(`Path=${LAB}`);
    }
  });

  it('flows, codes and sessions stay bounded; the admin\'s Citadel session is never pushed out', async () => {
    const { agent, sid } = await freshSession();
    await pidSignIn(agent, 'templar', 'pilgrim', 'pilgrim');
    for (let i = 0; i < 60; i++) await agent.get(`${LAB}/link?level=templar`);
    for (let i = 0; i < 60; i++) await agent.get(directAuthorize('templar', `s${i}`));
    for (let i = 0; i < 60; i++) await citadelSignIn(agent, 'templar', 'pilgrim', 'pilgrim');
    const lab = labState(sid, 'templar');
    expect(lab.flows.size).toBeLessThanOrEqual(50);
    expect(lab.codes.size).toBeLessThanOrEqual(50);
    expect(lab.clientSessions.size).toBeLessThanOrEqual(50);
    expect(lab.idpSessions.size).toBeLessThanOrEqual(50);
    expect(lab.clientSessions.get(lab.adminSession)).toBe(ADMIN);
  });

  it('wrong passwords sign in nowhere', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const [u, p] of [['pilgrim', 'nope'], [ADMIN, 'pilgrim'], [ADMIN, '']]) {
        expect((await citadelSignIn(agent, level, u, p)).text, level).toContain('Invalid username or password.');
        expect((await pidSignIn(agent, level, u, p)).text, level).toContain('Invalid username or password.');
      }
    }
  });
});

describe('GK-11 lab view specifics', () => {
  it('links the flows by their absolute paths and tells the registered redirect URIs', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'templar');
    for (const path of ['/link', '/login', '/idp', '/logout']) expect(page.text, path).toContain(`href="${LAB}${path}?level=templar"`);
    expect(page.text).toContain(`<code>${LINK_CB}</code>`);
    expect(page.text).toContain('<code>http://citadel.test/callback</code>');
  });

  it('the Pilgrim-ID page has its own sign-in form, posting back to itself', async () => {
    const { agent } = await freshSession();
    const page = await agent.get(`${LAB}/idp?level=acolyte`);
    expect(page.status).toBe(200);
    const forms = [...page.text.matchAll(/<form[^>]*>/g)].map((m) => m[0]).filter((f) => !f.includes('class="sim-action"'));
    expect(forms).toHaveLength(1);
    expect(forms[0]).not.toMatch(/\saction=/);
  });

  it('the victim action says what the admin does, in both languages', async () => {
    const { agent } = await freshSession();
    expect(panelOf((await home(agent, 'acolyte')).text)).toContain('opens any link you send, while signed in to Citadel');
    expect(panelOf((await home(agent, 'acolyte', 'id')).text)).toContain('membuka tautan apa pun yang Anda kirim, saat masuk ke Citadel');
  });
});
