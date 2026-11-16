// The simulated victim across sites (engine task E1, docs/RECIPES.md section 8 "Across sites"): the SameSite jar,
// Origin / Sec-Fetch shaping, CORS reads, framing, and the attacker-page presets. Everything is in process: no HTTP,
// no socket (the guard in tests/sim.spec.ts covers src/core/sim/ as a whole).
import { describe, expect, it } from 'vitest';
import { perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { Jar, sameSiteSends, sameSiteStores, type SimCookieContext, type SimSameSite } from '../src/core/sim/cookies.js';
import { ADMIN_MAILBOX, classifySimUrl, simWorld, type SimHandler, type SimRequest, type SimResponse, type SimWorld } from '../src/core/sim.js';

let n = 0;
/** Build sim state the way labs must: inside a perSession factory (one fresh session per call). */
function inSession<T>(make: () => T, level: Level = 'acolyte'): T {
  return perSession(() => make()).for({ sessionId: `cross-${++n}`, level });
}
const world = (): SimWorld => inSession(() => simWorld({ mailboxes: [ADMIN_MAILBOX] }));

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

const CITADEL = classifySimUrl('http://citadel.test/account');
const ctx = (site: 'same' | 'cross', method: 'GET' | 'POST', topLevel: boolean): SimCookieContext => ({ site, method, topLevel });

describe('the SameSite jar: what is sent (RFC 6265bis, current Chrome)', () => {
  // [SameSite, site, method, topLevel] -> sent?
  const MATRIX: readonly (readonly [SimSameSite, 'same' | 'cross', 'GET' | 'POST', boolean, boolean])[] = [
    ['Strict', 'same', 'GET', true, true], ['Strict', 'same', 'POST', true, true], ['Strict', 'same', 'GET', false, true],
    ['Strict', 'cross', 'GET', true, false], ['Strict', 'cross', 'POST', true, false],
    ['Strict', 'cross', 'GET', false, false], ['Strict', 'cross', 'POST', false, false],
    ['Lax', 'same', 'GET', true, true], ['Lax', 'same', 'POST', true, true], ['Lax', 'same', 'POST', false, true],
    ['Lax', 'cross', 'GET', true, true], // a cross-site link: the one cross-site request Lax allows
    ['Lax', 'cross', 'POST', true, false], // a cross-site form POST (no "Lax-allowing-unsafe" 2-minute exception)
    ['Lax', 'cross', 'GET', false, false], ['Lax', 'cross', 'POST', false, false], // a fetch or a frame
    ['None', 'same', 'GET', true, true], ['None', 'cross', 'POST', true, true],
    ['None', 'cross', 'GET', false, true], ['None', 'cross', 'POST', false, true],
  ];

  it('sameSiteSends: Strict only same-site; Lax also on a cross-site top-level GET; None always', () => {
    for (const [same, s, method, top, sent] of MATRIX) {
      expect(sameSiteSends(same, ctx(s, method, top)), `${same} ${s} ${method} top=${top}`).toBe(sent);
    }
  });

  it('the jar applies it per cookie, on top of path and Secure; with no context a request is a same-site navigation', () => {
    const jar = new Jar(() => 0);
    jar.set('strict', 's', { sameSite: 'Strict' });
    jar.set('lax', 'l'); // the default: Lax
    jar.set('none', 'n', { sameSite: 'None', secure: true });
    for (const [same, s, method, top] of MATRIX.filter(([x]) => x === 'Strict')) {
      const want = ['strict', 'lax', 'none'].filter((c) => sameSiteSends(({ strict: 'Strict', lax: 'Lax', none: 'None' } as const)[c as 'strict'], ctx(s, method, top)));
      const header = jar.headerFor(CITADEL, ctx(s, method, top));
      expect(header, `${same} ${s} ${method} top=${top}`).toBe(want.map((c) => `${c}=${c[0]}`).join('; '));
    }
    expect(jar.headerFor(CITADEL)).toBe('strict=s; lax=l; none=n');
    expect(jar.list().map((c) => c.sameSite)).toEqual(['Strict', 'Lax', 'None']);
  });

  it('set() takes sameSite (default Lax); None without secure: true, or an unknown value, is a programming error', () => {
    const jar = new Jar(() => 0);
    expect(() => jar.set('a', '1', { sameSite: 'None' })).toThrow(/sameSite 'None' needs secure: true/);
    expect(() => jar.set('a', '1', { sameSite: 'None', secure: false })).toThrow(/sameSite 'None' needs secure: true/);
    expect(() => jar.set('a', '1', { sameSite: 'lax' as never })).toThrow(/sameSite must be 'Strict', 'Lax' or 'None'/);
    expect(jar.size).toBe(0);
    jar.set('a', '1');
    expect(jar.list()[0]).toMatchObject({ name: 'a', sameSite: 'Lax', secure: false });
  });

  it('changing only a cookie\'s SameSite replaces it in place (a real change)', () => {
    const jar = new Jar(() => 0);
    jar.set('a', '1', { sameSite: 'Strict' });
    const v = jar.version;
    jar.set('a', '1', { sameSite: 'Strict' });
    expect(jar.version).toBe(v);
    jar.set('a', '1', { sameSite: 'None', secure: true });
    expect(jar.version).toBe(v + 1);
    expect(jar.list().map((c) => [c.name, c.sameSite])).toEqual([['a', 'None']]);
  });
});

describe('the SameSite jar: what is stored', () => {
  const lines = ['s=1; SameSite=Strict', 'l=2; SameSite=Lax', 'n=3; SameSite=None; Secure', 'd=4'];

  it('parses SameSite in any case; a missing or unknown value is Lax (Chrome\'s default)', () => {
    const w = world();
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': ['a=1; samesite=STRICT', 'b=2; SameSite=lax', 'c=3; SAMESITE=None; secure', 'd=4', 'e=5; SameSite=Bogus', 'f=6; SameSite'] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => [c.name, c.sameSite, c.secure])).toEqual([
      ['a', 'Strict', false], ['b', 'Lax', false], ['c', 'None', true], ['d', 'Lax', false], ['e', 'Lax', false], ['f', 'Lax', false],
    ]);
  });

  it('SameSite=None without Secure is refused, as Chrome refuses it', () => {
    const w = world();
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': ['bare=1; SameSite=None', 'ok=2; SameSite=None; Secure'] } } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => c.name)).toEqual(['ok']);
  });

  it('a cross-site response that is not a top-level navigation\'s (a fetch, a frame) stores only SameSite=None cookies', () => {
    for (const [s, method, top, want] of [
      ['same', 'GET', true, ['s', 'l', 'n', 'd']], ['same', 'GET', false, ['s', 'l', 'n', 'd']],
      ['cross', 'GET', true, ['s', 'l', 'n', 'd']], ['cross', 'POST', true, ['s', 'l', 'n', 'd']], // top-level: all
      ['cross', 'GET', false, ['n']], ['cross', 'POST', false, ['n']],
    ] as const) {
      const jar = new Jar(() => 0);
      for (const line of lines) jar.store(line, CITADEL, ctx(s, method, top));
      expect(jar.list().map((c) => c.name), `${s} ${method} top=${top}`).toEqual(want);
      for (const same of ['Strict', 'Lax', 'None'] as const) {
        expect(sameSiteStores(same, ctx(s, method, top))).toBe(same === 'None' || s === 'same' || top);
      }
    }
  });

  it('nor can such a response delete the admin\'s Lax session (a Max-Age=0 line is refused like any other)', () => {
    const jar = new Jar(() => 0);
    jar.set('sid', 'admin');
    jar.store('sid=; Max-Age=0; SameSite=Lax', CITADEL, ctx('cross', 'GET', false));
    jar.store('sid=; Max-Age=0', CITADEL, ctx('cross', 'POST', false));
    expect(jar.get('sid')).toBe('admin');
    jar.store('sid=; Max-Age=0', CITADEL, ctx('cross', 'POST', true)); // a top-level navigation's response may
    expect(jar.get('sid')).toBeUndefined();
  });
});

describe('Secure cookies: citadel.test is a secure context (as browsers treat loopback)', () => {
  it('a Secure cookie from http://citadel.test is kept and sent back over http and https', () => {
    const w = world();
    const s = site({ '/set': { status: 200, headers: { 'set-cookie': ['sec=1; Secure', 'none=2; SameSite=None; Secure'] } }, '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.follow('http://citadel.test/set');
    expect(b.cookies.list().map((c) => [c.name, c.secure])).toEqual([['sec', true], ['none', true]]);
    b.follow('http://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('sec=1; none=2');
    b.follow('https://citadel.test/me');
    expect(s.seen.at(-1)?.headers.cookie).toBe('sec=1; none=2');
  });

  it('a lab can sign the victim in with a SameSite=None; Secure cookie up front', () => {
    const w = world();
    const s = site({ '/me': { status: 200 } });
    const b = inSession(() => w.browser(s.handler));
    b.cookies.set('sid', 'admin', { sameSite: 'None', secure: true });
    b.follow('http://citadel.test/me');
    expect(s.seen[0].cookies.sid).toBe('admin');
  });
});
