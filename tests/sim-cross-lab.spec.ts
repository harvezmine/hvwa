// A cross-site lab in miniature (XS-01 "Citadel Forum"), exercising the E1 presets through real HTTP and the panel:
// the player writes an attacker page, asks the admin to open it (a forged form, a credentialed fetch) or to open a
// framing page (a click on a framed button), and reads what happened from the panel: their mailbox, their server's
// log and the browser's note. Acolyte trusts any site (a SameSite=None session, a reflected CORS origin, no framing
// header); Divine keeps a Strict session, checks Origin, sends no CORS headers and refuses frames.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { field, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';
import {
  ADMIN_MAILBOX, ATTACKER_EXFIL_URL, CITADEL_ORIGIN, PLAYER_MAILBOX, frameAndClickAction, sendAttackerPageAction, simWorld,
  visitAttackerPageAction, type AttackerScript, type SimBrowser, type SimRequest, type SimResponse, type SimWorld,
} from '../src/core/sim.js';
import { attackerHits, freshSession, panelOf, unescapeHtml, type Agent } from './helpers.js';

const hello = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ejs');
const LAB = '/d/sim-test/cross';
const CANARY = 'FORUM-CANARY-1';

// --- The fixture lab -------------------------------------------------------------------------------------------

interface Forum {
  readonly world: SimWorld;
  admin: SimBrowser;
  email: string;
  readonly moderators: string[];
  page?: AttackerScript;
}

/** The "level files": which site the forum trusts. */
const TRUSTING: Readonly<Record<Level, boolean>> = { acolyte: true, templar: true, inquisitor: true, divine: false };

function citadel(level: Level, lab: Forum, r: SimRequest): SimResponse {
  const trusting = TRUSTING[level];
  const signedIn = r.cookies.sid === 'admin';
  if (r.path === '/account/email' && r.method === 'POST') {
    if (!signedIn) return { status: 403, body: 'Sign in first.' };
    if (!trusting && r.headers.origin !== CITADEL_ORIGIN) return { status: 403, body: 'Cross-site request refused.' };
    lab.email = r.body.email ?? '';
    lab.world.inbox.deliver({ from: 'forum@citadel.test', to: lab.email, subject: 'Confirm your new address', body: `Code: ${CANARY}` });
    return { status: 303, headers: { Location: '/account' } };
  }
  if (r.path === '/api/me') {
    const cors = trusting ? { 'Access-Control-Allow-Origin': r.headers.origin ?? '', 'Access-Control-Allow-Credentials': 'true' } : {};
    return { status: 200, headers: cors, body: JSON.stringify(signedIn ? { user: 'citadel_admin', canary: CANARY } : { user: null }) };
  }
  if (r.path === '/moderation/confirm') {
    const frames = trusting ? {} : { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };
    return { status: 200, headers: frames, body: signedIn ? 'Approve pilgrim as a moderator? [Approve]' : 'Sign in.' };
  }
  if (r.path === '/moderation/grant' && r.method === 'POST') {
    if (!signedIn) return { status: 403, body: 'Sign in first.' };
    lab.moderators.push(r.body.user ?? '');
    return { status: 200, body: 'Granted.' };
  }
  return { status: 200, body: 'Forum' };
}

const labs = perSession((level): Forum => {
  const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
  const lab: Forum = { world, admin: undefined as never, email: ADMIN_MAILBOX, moderators: [] };
  lab.admin = world.browser((r) => citadel(level, lab, r));
  return lab;
});
const labFor = (req: { sessionId: string; level: Level }): Forum => labs.for(req);
/** The admin is signed in with the session cookie its level sets: SameSite=None at Acolyte, Strict at Divine. */
const rearm = (req: Request, admin: SimBrowser): void => {
  admin.cookies.set('sid', 'admin', TRUSTING[req.level] ? { sameSite: 'None', secure: true } : { sameSite: 'Strict' });
};

register(defineChallenge({
  id: 'XS-01', district: 'sim-test', slug: 'cross', dir: process.cwd(),
  title: { id: 'Forum', en: 'Forum' }, summary: { id: 'Fixture', en: 'Fixture' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      visitAttackerPageAction({ browser: (req) => labFor(req).admin, page: (req) => labFor(req).page, rearm }),
      sendAttackerPageAction({ browser: (req) => labFor(req).admin, page: (req) => labFor(req).page, rearm }),
      frameAndClickAction({
        browser: (req) => labFor(req).admin, rearm,
        // The confirm page's one button posts the grant form: the lab knows its own page.
        click: (_req, framed) => (new URL(framed.url).pathname === '/moderation/confirm' ? { action: '/moderation/grant', fields: { user: 'pilgrim' } } : undefined),
      }),
    ],
  },
  mount: (router) => {
    router.get('/', (_req, res) => sendPage(res, hello, { name: 'forum' }));
    // The player's attacker page, as this lab lets them write it: a forged email form, or a fetch of the API.
    router.post('/page', (req, res) => {
      const lab = labFor(req);
      lab.page = field(req, 'kind') === 'fetch'
        ? { does: { kind: 'fetch', url: 'http://citadel.test/api/me', credentials: 'include' } }
        : { does: { kind: 'form', action: 'http://citadel.test/account/email', fields: { email: field(req, 'email') } } };
      res.redirect(303, `${LAB}?level=${req.level}`);
    });
  },
}));

// --- Scripts, as a player would ----------------------------------------------------------------------------------

const writePage = (agent: Agent, level: Level, body: Record<string, string>) => agent.post(`${LAB}/page?level=${level}`).type('form').send(body);
const act = (agent: Agent, level: Level, name: string, url?: string) =>
  agent.post(`${LAB}/victim/${name}?level=${level}`).type('form').send(url === undefined ? {} : { url });
const panel = async (agent: Agent, level: Level, lang = 'en') => panelOf((await agent.get(`${LAB}?level=${level}&lang=${lang}`)).text);
const noteOf = (html: string): string | undefined => {
  const m = /<p class="sim-note">([^<]*)<\/p>/.exec(html);
  return m ? unescapeHtml(m[1]) : undefined;
};

describe('XS-01: the cross-site presets through the panel', () => {
  it('the panel offers the three actions, each saying what the admin does, in both languages', async () => {
    const { agent } = await freshSession();
    const en = await panel(agent, 'acolyte');
    for (const name of ['visit-attacker-page', 'send-attacker-page', 'frame-and-click']) expect(en).toContain(`data-testid="sim-action-${name}"`);
    expect(en).toContain('opens your page on attacker.test, which does what you wrote on it');
    expect(en).toContain('opens your page, which frames the citadel.test link you send, and clicks your decoy button');
    expect(en.match(/name="url"/g)).toHaveLength(2); // the send and the frame actions take a link
    const id = await panel(agent, 'acolyte', 'id');
    expect(id).toContain('Minta admin membuka halaman Anda');
    expect(id).toContain('membingkai tautan citadel.test yang Anda kirim');
  });

  it('CSRF: at Acolyte the forged form changes the admin\'s email; the confirmation (with its code) lands in YOUR mailbox', async () => {
    const { agent, sid } = await freshSession();
    await writePage(agent, 'acolyte', { kind: 'form', email: PLAYER_MAILBOX });
    expect((await act(agent, 'acolyte', 'visit-attacker-page')).status).toBe(303);
    const html = await panel(agent, 'acolyte');
    expect(html).toContain('Confirm your new address');
    expect(html).toContain(`Code: ${CANARY}`);
    expect(attackerHits(html).map((h) => `${h.method} ${h.url}`)).toEqual(['GET http://attacker.test/']); // your page's load
    expect(html).toContain('Visit 1: 1 request(s); reached your server (attacker.test).');
    expect(html).toContain('Visit 2: 2 request(s); ended on a citadel.test page (HTTP 200).'); // the POST, then its 303
    expect(labFor({ sessionId: sid, level: 'acolyte' }).email).toBe(PLAYER_MAILBOX);
  });

  it('CSRF: at Divine the Strict session stays home and Origin is checked: nothing changes, no mail', async () => {
    const { agent, sid } = await freshSession();
    await writePage(agent, 'divine', { kind: 'form', email: PLAYER_MAILBOX });
    await act(agent, 'divine', 'visit-attacker-page');
    expect(await panel(agent, 'divine')).not.toContain('Confirm your new address');
    expect(labFor({ sessionId: sid, level: 'divine' }).email).toBe(ADMIN_MAILBOX);
  });

  it('CORS: at Acolyte the page reads /api/me with the admin\'s cookie and sends it home; at Divine the read is blocked', async () => {
    const { agent } = await freshSession();
    await writePage(agent, 'acolyte', { kind: 'fetch' });
    await act(agent, 'acolyte', 'visit-attacker-page');
    const open = await panel(agent, 'acolyte');
    expect(noteOf(open)).toBe('Your page read the answer and sent it to your server.');
    const exfil = attackerHits(open).find((h) => h.url === ATTACKER_EXFIL_URL);
    expect(JSON.parse(exfil?.body ?? '{}')).toEqual({ user: 'citadel_admin', canary: CANARY });
    await writePage(agent, 'divine', { kind: 'fetch' });
    await act(agent, 'divine', 'visit-attacker-page');
    const shut = await panel(agent, 'divine', 'id');
    expect(noteOf(shut)).toMatch(/tidak ada Access-Control-Allow-Origin/);
    expect(attackerHits(shut).map((h) => h.url)).toEqual(['http://attacker.test/']);
  });

  it('clickjacking: at Acolyte the framed confirm page is clicked through; at Divine the frame stays empty and the note says why', async () => {
    const { agent, sid } = await freshSession();
    await act(agent, 'acolyte', 'frame-and-click', 'http://citadel.test/moderation/confirm');
    expect(labFor({ sessionId: sid, level: 'acolyte' }).moderators).toEqual(['pilgrim']);
    expect(await panel(agent, 'acolyte')).toContain('value="http://citadel.test/moderation/confirm"'); // the link field keeps it
    await act(agent, 'divine', 'frame-and-click', 'http://citadel.test/moderation/confirm');
    expect(noteOf(await panel(agent, 'divine'))).toBe('The browser refused to show that page in your frame: Content-Security-Policy frame-ancestors.');
    expect(labFor({ sessionId: sid, level: 'divine' }).moderators).toEqual([]);
  });

  it('the page at a link you send runs there; a link off attacker.test is never opened', async () => {
    const { agent } = await freshSession();
    await writePage(agent, 'acolyte', { kind: 'form', email: PLAYER_MAILBOX });
    await act(agent, 'acolyte', 'send-attacker-page', 'http://citadel.test/account/email');
    const refused = await panel(agent, 'acolyte');
    expect(noteOf(refused)).toBe('That link is not on your server (attacker.test); the admin does not open it.');
    expect(attackerHits(refused)).toEqual([]);
    await act(agent, 'acolyte', 'send-attacker-page', 'http://citadel.attacker.test/csrf.html');
    const sent = await panel(agent, 'acolyte');
    expect(attackerHits(sent).map((h) => h.url)).toEqual(['http://citadel.attacker.test/csrf.html']);
    expect(sent).toContain('Confirm your new address');
  });

  it('with no page written, the admin opens nothing and the note says so', async () => {
    const { agent } = await freshSession();
    await act(agent, 'acolyte', 'visit-attacker-page');
    const html = await panel(agent, 'acolyte');
    expect(noteOf(html)).toBe('You have not written your attacker page yet.');
    expect(html).toContain('The victim&#39;s browser opened nothing.'); // the panel escapes the apostrophe
  });
});
