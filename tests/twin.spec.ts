// tests/twin.spec.ts — the Reply adapter of the victim-driven labs (core/twin.ts): what each browser receives from one Reply.
import { fileURLToPath } from 'node:url';
import { renderFile } from 'ejs';
import type { Request, Response } from 'express';
import { describe, it, expect } from 'vitest';
import { freshSession } from './helpers.js';
import { perSession } from '../src/core/lab.js';
import { defineChallenge, register } from '../src/core/registry.js';
import {
  REDIRECT_STATUSES, cookiePath, sendReply, simVisitOf, simWorld, toSim, visitOf, type ForwardNote, type Reply, type SimRequest,
} from '../src/core/sim.js';

describe('twin: a Reply for the simulated browser', () => {
  it('a page: status and body, no headers it did not ask for', () => {
    expect(toSim({ status: 200, text: 'Hello.' })).toEqual({ status: 200, headers: {}, body: 'Hello.' });
  });

  it('a redirect carries its Location; a forwarding page carries Refresh: 0 and its Referrer-Policy', () => {
    expect(toSim({ status: 302, location: '/idp/authorize?x=1', text: '' }).headers).toEqual({ Location: '/idp/authorize?x=1' });
    expect(toSim({ status: 200, forward: 'http://attacker.test/', referrerPolicy: 'no-referrer', text: 'On we go.' }).headers)
      .toEqual({ Refresh: '0; url=http://attacker.test/', 'Referrer-Policy': 'no-referrer' });
  });

  it('cookies become Set-Cookie lines on their path; a cleared one expires at once', () => {
    const r = toSim({
      status: 200, text: '',
      cookies: [{ name: 'a_acolyte', value: 'v1', path: '/' }, { name: 'b_acolyte', value: '', path: '/', clear: true }],
    });
    expect(r.headers?.['Set-Cookie']).toEqual([
      'a_acolyte=v1; Path=/; HttpOnly; SameSite=Lax',
      'b_acolyte=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
  });

  it('a value is URL-encoded as res.cookie() does, so both browsers read back the same value', () => {
    const r = toSim({ status: 200, text: '', cookies: [{ name: 'next_acolyte', value: 'http://attacker.test/?a=1;b', path: '/' }] });
    expect(r.headers?.['Set-Cookie']).toEqual(['next_acolyte=http%3A%2F%2Fattacker.test%2F%3Fa%3D1%3Bb; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('the citadel (base \'\') puts its cookies on /, a real route on the lab path', () => {
    expect(cookiePath('')).toBe('/');
    expect(cookiePath('/d/gatekeeper/x')).toBe('/d/gatekeeper/x');
  });

  it('cookie attributes per cookie: HttpOnly can be dropped, SameSite chosen, Secure added; the default stays HttpOnly + Lax', () => {
    const r = toSim({
      status: 200, text: '',
      cookies: [
        { name: 'js_acolyte', value: '1', path: '/', httpOnly: false },
        { name: 'strict_acolyte', value: '2', path: '/', sameSite: 'Strict' },
        { name: 'none_acolyte', value: '3', path: '/', sameSite: 'None', secure: true, maxAgeSec: 60 },
        { name: 'lax_acolyte', value: '4', path: '/', httpOnly: true, sameSite: 'Lax', secure: false },
        { name: 'gone_acolyte', value: '', path: '/', clear: true, httpOnly: false, sameSite: 'None', secure: true },
      ],
    });
    expect(r.headers?.['Set-Cookie']).toEqual([
      'js_acolyte=1; Path=/; SameSite=Lax',
      'strict_acolyte=2; Path=/; HttpOnly; SameSite=Strict',
      'none_acolyte=3; Path=/; Max-Age=60; HttpOnly; SameSite=None; Secure',
      'lax_acolyte=4; Path=/; HttpOnly; SameSite=Lax',
      'gone_acolyte=; Path=/; Max-Age=0; SameSite=None; Secure',
    ]);
  });

  it('a SameSite other than Strict, Lax or None is a programming error', () => {
    for (const sameSite of ['lax', 'strict', 'none', '', 'Lax; Secure']) {
      expect(() => toSim({ status: 200, text: '', cookies: [{ name: 'a', value: '', path: '/', sameSite: sameSite as never }] }), sameSite)
        .toThrow(/sameSite must be 'Strict', 'Lax' or 'None'/);
    }
  });

  it('SameSite=None without secure: true is a programming error, set or cleared (browsers drop such a cookie)', () => {
    const none = [
      { name: 'a', value: '1', path: '/', sameSite: 'None' },
      { name: 'a', value: '1', path: '/', sameSite: 'None', secure: false },
      { name: 'a', value: '', path: '/', clear: true, sameSite: 'None' },
    ] as const;
    for (const c of none) {
      expect(() => toSim({ status: 200, text: '', cookies: [c] }), JSON.stringify(c)).toThrow(/sameSite 'None' needs secure: true/);
    }
    expect(toSim({ status: 200, text: '', cookies: [{ name: 'a', value: '1', path: '/', sameSite: 'None', secure: true }] }).headers?.['Set-Cookie'])
      .toEqual(['a=1; Path=/; HttpOnly; SameSite=None; Secure']);
  });

  it('the engine\'s redirect statuses are the only ones a Reply redirects on', () => {
    expect([...REDIRECT_STATUSES]).toEqual([301, 302, 303, 307, 308]);
  });
});

// --- sendReply: the same Replies for the player's real browser, through a fixture lab -------------------------------

const LAB = '/d/twin-test/reply';
const REPLIES: Readonly<Record<string, Reply>> = {
  page: { status: 200, text: 'A page.' },
  redirect: { status: 302, location: '/next?a=1', text: '' },
  seeOther: { status: 303, location: 'http://citadel.test/elsewhere', text: '' },
  locationOn200: { status: 200, location: 'http://citadel.test/elsewhere', text: 'Still a page.' },
  locationOn400: { status: 400, location: 'http://attacker.test/', text: 'Refused.' },
  cookies: {
    status: 200, text: '',
    cookies: [{ name: 'tw_acolyte', value: 'a;b c', path: LAB }, { name: 'gone_acolyte', value: '', path: LAB, clear: true }],
  },
  shortLived: { status: 200, text: '', cookies: [{ name: 'short_acolyte', value: 'x', path: LAB, maxAgeSec: 600 }] },
  attributes: {
    status: 200, text: '',
    cookies: [
      { name: 'js_acolyte', value: 'x', path: LAB, httpOnly: false },
      { name: 'strict_acolyte', value: 'y', path: LAB, sameSite: 'Strict' },
      { name: 'none_acolyte', value: 'z', path: LAB, sameSite: 'None', secure: true, maxAgeSec: 60 },
      { name: 'gone_acolyte', value: '', path: LAB, clear: true, httpOnly: false, sameSite: 'Strict' },
    ],
  },
  secureOnly: { status: 200, text: '', cookies: [{ name: 'sec_acolyte', value: 's', path: '/', secure: true }, { name: 'plain_acolyte', value: 'p', path: '/' }] },
  forwardCitadel: { status: 200, forward: '/home?x=1', text: 'Signed in.' },
  forwardLab: { status: 200, forward: `${LAB}/inner?y=2`, text: 'Signed in.' },
  forwardAttacker: { status: 200, forward: 'http://attacker.test/x?code=1', text: 'Signed in.' },
  forwardScript: { status: 200, forward: 'javascript:alert(1)', text: 'Signed in.' },
  redirectAndForward: { status: 302, location: '/a', forward: 'http://attacker.test/', text: '' },
};
const replyNamed = (name: string): Reply => {
  if (!Object.hasOwn(REPLIES, name)) throw new Error(`no fixture reply ${name}`);
  return REPLIES[name];
};

register(defineChallenge({
  id: 'TW-01', district: 'twin-test', slug: 'reply', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  mount: (router) => {
    router.get('/reply/:name', (req, res) => sendReply(res, replyNamed(String(req.params.name)), async (forward) => {
      res.json({ rendered: true, ...(forward === undefined ? {} : { forward }) });
    }));
  },
}));

// The simulated browser on the same Replies: /start/<name> answers toSim(that Reply), any other page 'landed'.
const sims = perSession(() => {
  const world = simWorld();
  return world.browser((r) => (r.path.startsWith('/start/') ? toSim(replyNamed(r.path.slice('/start/'.length))) : { status: 200, body: 'landed' }));
});
const simVisit = (name: string) => sims.for({ sessionId: `sim-${name}`, level: 'acolyte' }).follow(`http://citadel.test/start/${name}`);

describe('twin: sendReply for the real browser', () => {
  it('a page is rendered at its status', async () => {
    const { agent } = await freshSession();
    const page = await agent.get(`${LAB}/reply/page?level=acolyte`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ rendered: true });
  });

  it('a 3xx Location goes through sendSimRedirect: into the lab, at the served level', async () => {
    const { agent } = await freshSession();
    const r302 = await agent.get(`${LAB}/reply/redirect?level=acolyte`);
    expect(r302.status).toBe(302);
    expect(r302.headers.location).toBe(`${LAB}/next?a=1&level=acolyte`);
    const r303 = await agent.get(`${LAB}/reply/seeOther?level=divine`);
    expect(r303.status).toBe(303);
    expect(r303.headers.location).toBe(`${LAB}/elsewhere?level=divine`);
  });

  it('a Location on a status that is not a redirect is a page, as the simulated browser treats it', async () => {
    const { agent } = await freshSession();
    for (const [name, status] of [['locationOn200', 200], ['locationOn400', 400]] as const) {
      const res = await agent.get(`${LAB}/reply/${name}?level=acolyte`);
      expect(res.status, name).toBe(status);
      expect(res.headers.location, name).toBeUndefined();
      expect(res.body, name).toEqual({ rendered: true });
      const visit = simVisit(name);
      expect(visit.outcome, name).toBe('page');
      expect(visit.hops, name).toHaveLength(1);
    }
    expect(simVisit('redirect').hops.map((h) => h.via)).toEqual(['start', 'redirect']); // a real 3xx: both follow it
  });

  it('cookies are set on their path, HttpOnly and SameSite=Lax, values URL-encoded; a cleared one expires', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/reply/cookies?level=acolyte`);
    const lines = [res.headers['set-cookie'] ?? []].flat();
    expect(lines).toContain(`tw_acolyte=a%3Bb%20c; Path=${LAB}; HttpOnly; SameSite=Lax`);
    expect(lines.find((l) => l.startsWith('gone_acolyte='))).toMatch(new RegExp(`^gone_acolyte=; Path=${LAB}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$`));
  });

  it('a short-lived cookie carries its Max-Age in both browsers', async () => {
    const { agent } = await freshSession();
    const line = [(await agent.get(`${LAB}/reply/shortLived?level=acolyte`)).headers['set-cookie'] ?? []].flat()
      .find((l) => l.startsWith('short_acolyte='));
    expect(line).toMatch(new RegExp(`^short_acolyte=x; Max-Age=600; Path=${LAB}; Expires=[^;]+; HttpOnly; SameSite=Lax$`));
    expect(toSim(replyNamed('shortLived')).headers?.['Set-Cookie']).toEqual([`short_acolyte=x; Path=${LAB}; Max-Age=600; HttpOnly; SameSite=Lax`]);
  });

  it('cookie attributes reach the real browser too: no HttpOnly when asked, SameSite per cookie, Secure', async () => {
    const { agent } = await freshSession();
    const lines = [(await agent.get(`${LAB}/reply/attributes?level=acolyte`)).headers['set-cookie'] ?? []].flat();
    const line = (name: string) => lines.find((l) => l.startsWith(`${name}=`));
    expect(line('js_acolyte')).toBe(`js_acolyte=x; Path=${LAB}; SameSite=Lax`);
    expect(line('strict_acolyte')).toBe(`strict_acolyte=y; Path=${LAB}; HttpOnly; SameSite=Strict`);
    expect(line('none_acolyte')).toMatch(new RegExp(`^none_acolyte=z; Max-Age=60; Path=${LAB}; Expires=[^;]+; HttpOnly; Secure; SameSite=None$`));
    expect(line('gone_acolyte')).toBe(`gone_acolyte=; Path=${LAB}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict`);
  });

  it('the simulated browser keeps a Secure cookie from http://citadel.test: a secure context, as browsers treat loopback (E1)', () => {
    // Inverted on purpose by engine task E1: the sim jar used to refuse it (plain http), so a `SameSite=None; Secure`
    // TwinCookie could not work in both browsers. The player's own browser keeps it from http://127.0.0.1 in
    // Chromium and Firefox (Safari may not).
    const browser = sims.for({ sessionId: 'sim-secure', level: 'acolyte' });
    browser.follow('http://citadel.test/start/secureOnly');
    expect(browser.cookies.list().find((c) => c.name === 'sec_acolyte')).toMatchObject({ value: 's', secure: true, sameSite: 'Lax' });
    expect(browser.cookies.get('plain_acolyte')).toBe('p');
  });

  it('a SameSite=None; Secure TwinCookie reaches the simulated jar with its SameSite', () => {
    const browser = sims.for({ sessionId: 'sim-none', level: 'acolyte' });
    browser.follow('http://citadel.test/start/attributes');
    expect(browser.cookies.list().map((c) => [c.name, c.sameSite, c.secure])).toEqual([
      ['js_acolyte', 'Lax', false], ['strict_acolyte', 'Strict', false], ['none_acolyte', 'None', true],
    ]);
  });
});

describe('twin: a page that moves on by itself, in the real browser', () => {
  const get = async (name: string, lang = 'en') => (await freshSession()).agent.get(`${LAB}/reply/${name}?level=acolyte&lang=${lang}`);
  const noWayOut = (res: { status: number; headers: Record<string, unknown> }, name: string) => {
    expect(res.status, name).toBe(200);
    expect(res.headers.location, name).toBeUndefined();
    expect(res.headers.refresh, name).toBeUndefined();
  };

  it('a citadel target: the page is rendered with a note and a link to the same place in the lab', async () => {
    const res = await get('forwardCitadel');
    noWayOut(res, 'forwardCitadel');
    expect(res.body).toEqual({
      rendered: true,
      forward: { url: 'http://citadel.test/home?x=1', href: `${LAB}/home?x=1&level=acolyte`, lead: 'This page moves the browser on by itself to:', action: 'Continue there in the lab' },
    });
    const lab = await get('forwardLab'); // a target a level built on labPath(res)
    noWayOut(lab, 'forwardLab');
    expect(lab.body.forward).toMatchObject({ url: 'http://citadel.test/inner?y=2', href: `${LAB}/inner?y=2&level=acolyte` });
    expect(simVisit('forwardCitadel').hops.map((h) => h.via)).toEqual(['start', 'refresh']); // the victim's browser follows
  });

  it('any other target: rendered with the URL as text and no link, in the player\'s language', async () => {
    for (const [name, url] of [['forwardAttacker', 'http://attacker.test/x?code=1'], ['forwardScript', 'javascript:alert(1)']] as const) {
      const res = await get(name);
      noWayOut(res, name);
      expect(res.body.forward, name).toEqual({
        url, lead: 'This page moves the browser on by itself to:',
        action: 'Your browser stays in the lab; only the simulated victim\'s browser really goes there.',
      });
    }
    expect((await get('forwardAttacker', 'id')).body.forward).toMatchObject({
      lead: 'Halaman ini memindahkan peramban dengan sendirinya ke:',
      action: 'Peramban Anda tetap di lab; hanya peramban korban tersimulasi yang benar-benar pergi ke sana.',
    });
    expect(simVisit('forwardAttacker').outcome).toBe('attacker');
  });

  it('a redirect wins over a forward, in both browsers', async () => {
    const res = await get('redirectAndForward');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${LAB}/a?level=acolyte`);
    expect(simVisit('redirectAndForward').hops.map((h) => h.via)).toEqual(['start', 'redirect']);
  });

  it('the shared note escapes the URL and links only a lab target', async () => {
    const partial = fileURLToPath(new URL('../src/core/views/forward-note.ejs', import.meta.url));
    const render = (forward: unknown) => renderFile(partial, { forward }, { async: false }) as unknown as Promise<string>;
    const away = await render({ url: 'http://attacker.test/"><b>x</b>', lead: 'L', action: 'A' });
    expect(away).toContain('<code>http://attacker.test/&#34;&gt;&lt;b&gt;x&lt;/b&gt;</code>');
    expect(away).not.toMatch(/<a\b|href=|<b>/);
    const inLab = await render({ url: 'http://citadel.test/', href: `${LAB}?level=acolyte`, lead: 'L', action: 'Go' });
    expect(inLab).toContain(`<a href="${LAB}?level=acolyte">Go</a>`);
    expect((await render(null)).trim()).toBe('');
  });
});

// --- sendReply on its own: a fake Response records what it is asked to do ------------------------------------------

describe('twin: sendReply, unit (a fake Response)', () => {
  type Call = readonly unknown[];
  const fake = (level = 'templar') => {
    const calls: Call[] = [];
    const res = {
      locals: { labPath: '/d/unit/twin', lang: 'en' }, req: { path: '/cb', level },
      cookie: (...a: unknown[]) => { calls.push(['cookie', ...a]); return res; },
      clearCookie: (...a: unknown[]) => { calls.push(['clearCookie', ...a]); return res; },
      status: (n: number) => { calls.push(['status', n]); return res; },
      redirect: (...a: unknown[]) => { calls.push(['redirect', ...a]); },
    };
    return { res: res as unknown as Response, calls };
  };
  const renderer = () => {
    const seen: (ForwardNote | undefined)[] = [];
    return { seen, render: async (forward?: ForwardNote) => { seen.push(forward); } };
  };

  it('sets every cookie with its attributes (default HttpOnly + Lax), then renders the page at its status', async () => {
    const { res, calls } = fake();
    const { seen, render } = renderer();
    await sendReply(res, {
      status: 201, text: 'Made.',
      cookies: [
        { name: 'a', value: 'v', path: '/d/unit/twin' },
        { name: 'b', value: 'w', path: '/d/unit/twin', httpOnly: false, sameSite: 'None', secure: true, maxAgeSec: 5 },
        { name: 'c', value: '', path: '/d/unit/twin', clear: true, sameSite: 'Strict' },
      ],
    }, render);
    expect(calls).toEqual([
      ['cookie', 'a', 'v', { path: '/d/unit/twin', httpOnly: true, sameSite: 'lax' }],
      ['cookie', 'b', 'w', { path: '/d/unit/twin', httpOnly: false, sameSite: 'none', secure: true, maxAge: 5000 }],
      ['clearCookie', 'c', { path: '/d/unit/twin', httpOnly: true, sameSite: 'strict' }],
      ['status', 201],
    ]);
    expect(seen).toEqual([undefined]);
  });

  it('a cookie it refuses (SameSite=None without Secure) fails the Reply before any cookie is set or anything rendered', async () => {
    const { res, calls } = fake();
    const { seen, render } = renderer();
    await expect(sendReply(res, {
      status: 200, text: '',
      cookies: [{ name: 'ok', value: 'v', path: '/d/unit/twin' }, { name: 'bad', value: 'w', path: '/d/unit/twin', sameSite: 'None' }],
    }, render)).rejects.toThrow(/TwinCookie "bad": sameSite 'None' needs secure: true/);
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('a redirect status with a Location goes through sendSimRedirect into the lab, and nothing is rendered', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { res, calls } = fake();
      const { seen, render } = renderer();
      await sendReply(res, { status, location: '/next?a=1', text: '' }, render);
      expect(calls, String(status)).toEqual([['redirect', status, '/d/unit/twin/next?a=1&level=templar']]);
      expect(seen, String(status)).toEqual([]);
    }
  });

  it('a Location on any other status is ignored: the page is rendered at that status', async () => {
    for (const status of [200, 300, 304, 400]) {
      const { res, calls } = fake();
      const { seen, render } = renderer();
      await sendReply(res, { status, location: 'http://attacker.test/', text: 'Page.' }, render);
      expect(calls, String(status)).toEqual([['status', status]]);
      expect(seen, String(status)).toEqual([undefined]);
    }
  });

  it('a forward is handed to the view as a ForwardNote; the browser is never sent on', async () => {
    const { res, calls } = fake('inquisitor');
    const { seen, render } = renderer();
    await sendReply(res, { status: 200, forward: 'http://citadel.test/home', text: 'Signed in.' }, render);
    expect(calls).toEqual([['status', 200]]);
    expect(seen).toEqual([{
      url: 'http://citadel.test/home', href: '/d/unit/twin/home?level=inquisitor',
      lead: 'This page moves the browser on by itself to:', action: 'Continue there in the lab',
    }]);
  });
});

// --- Visit: what a lab page needs from either browser's request ----------------------------------------------------

describe('twin: Visit', () => {
  const res = { locals: { labPath: '/d/unit/twin' } } as unknown as Response;

  it('visitOf: the raw query, only the named lab cookies that are strings, and labPath(res) as the base', () => {
    const req = {
      level: 'inquisitor', originalUrl: '/D/UNIT/TWIN/cb?code=a&code=b&next=%2F&level=inquisitor',
      cookies: { a_inquisitor: 'v1', b_inquisitor: { j: 1 }, other: 'z', hvwa_sid: 's' },
    } as unknown as Request;
    const v = visitOf(req, res, ['a_inquisitor', 'b_inquisitor', 'missing_inquisitor']);
    expect(v.level).toBe('inquisitor');
    expect(v.base).toBe('/d/unit/twin');
    expect(v.query.getAll('code')).toEqual(['a', 'b']);
    expect(v.query.get('next')).toBe('/');
    expect({ ...v.cookies }).toEqual({ a_inquisitor: 'v1' });
    expect(Object.getPrototypeOf(v.cookies)).toBeNull();
  });

  it('visitOf: the query is everything after the FIRST ?, so a URL in a parameter keeps its own ? and what follows', () => {
    const req = { level: 'inquisitor', originalUrl: '/d/unit/twin/login?next=http://attacker.test/a?b=1&level=inquisitor' } as unknown as Request;
    const v = visitOf(req, res, []);
    expect([...v.query]).toEqual([['next', 'http://attacker.test/a?b=1'], ['level', 'inquisitor']]);
    const bare = visitOf({ level: 'acolyte', originalUrl: '/d/unit/twin/x??a=1' } as unknown as Request, res, []);
    expect([...bare.query]).toEqual([['?a', '1']]);
  });

  it('visitOf: no query string and no parsed cookies are an empty query and no cookies', () => {
    const v = visitOf({ level: 'acolyte', originalUrl: '/d/unit/twin' } as unknown as Request, res, ['a_acolyte']);
    expect([...v.query]).toEqual([]);
    expect({ ...v.cookies }).toEqual({});
  });

  it('simVisitOf with the lab\'s cookie names keeps only those, as visitOf does: both browsers show a page the same cookies', () => {
    const jar = (): Record<string, string> => Object.assign(Object.create(null) as Record<string, string>, { a_divine: 'v', other: 'z', b_acolyte: 'w' });
    const names = ['a_divine', 'missing_divine'];
    const sim = simVisitOf('divine', { query: new URLSearchParams(''), cookies: jar() } as unknown as SimRequest, names);
    expect({ ...sim.cookies }).toEqual({ a_divine: 'v' });
    expect(Object.getPrototypeOf(sim.cookies)).toBeNull();
    const real = visitOf({ level: 'divine', originalUrl: '/d/unit/twin', cookies: jar() } as unknown as Request, res, names);
    expect({ ...sim.cookies }).toEqual({ ...real.cookies });
  });

  it('simVisitOf: the victim\'s request on the citadel, base \'\'', () => {
    const r = { query: new URLSearchParams('x=1'), cookies: { a_divine: 'v' } } as unknown as SimRequest;
    const v = simVisitOf('divine', r);
    expect(v).toMatchObject({ level: 'divine', query: r.query, cookies: r.cookies, base: '' });
    // E1b adds the request itself (tests/twin-visit.spec.ts); a bare request gives empty parts and the citadel as self.
    expect([v.method, { ...v.headers }, { ...v.body }, v.text, v.self]).toEqual(['GET', {}, {}, '', 'http://citadel.test']);
  });
});
