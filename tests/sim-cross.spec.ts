// The simulated victim across sites (engine task E1, docs/RECIPES.md section 8 "Across sites"): the SameSite jar,
// Origin / Sec-Fetch shaping, CORS reads, framing, and the attacker-page presets. Everything is in process: no HTTP,
// no socket (the guard in tests/sim.spec.ts covers src/core/sim/ as a whole).
import { describe, expect, it } from 'vitest';
import { perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { Jar, sameSiteSends, sameSiteStores, type SimCookieContext, type SimSameSite } from '../src/core/sim/cookies.js';
import { bodyFields, framingOf } from '../src/core/sim/cross.js';
import {
  ADMIN_MAILBOX, SIM_FORM_BOUNDARY, classifySimUrl, simWorld, type SimFormFields, type SimHandler, type SimRequest, type SimResponse,
  type SimWorld,
} from '../src/core/sim.js';

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

// --- Requests across sites: who sends what ------------------------------------------------------------------------

/** A victim signed in with one cookie of each SameSite, on a citadel that answers every path with `answer`. */
function victim(answer: (r: SimRequest) => SimResponse = () => ({ status: 200, body: 'ok' })) {
  const w = world();
  const seen: SimRequest[] = [];
  const b = inSession(() => w.browser((r) => { seen.push(r); return answer(r); }));
  b.cookies.set('strict', 's', { sameSite: 'Strict' });
  b.cookies.set('lax', 'l', { sameSite: 'Lax' });
  b.cookies.set('none', 'n', { sameSite: 'None', secure: true });
  return { w, b, seen };
}
type Victim = ReturnType<typeof victim>;
const sentCookies = (r: SimRequest | undefined): string[] => Object.keys(r?.cookies ?? {});
const fetchMeta = (r: SimRequest | undefined) => [r?.headers['sec-fetch-site'], r?.headers['sec-fetch-mode'], r?.headers['sec-fetch-dest']];
const TARGET = 'http://citadel.test/account/email';

/** One way the victim's browser requests the citadel, with what it must send. */
interface Kind {
  readonly name: string;
  readonly run: (b: Victim['b']) => void;
  readonly cookies: readonly string[];
  readonly origin: string | undefined;
  readonly fetch: readonly (string | undefined)[];
}
const NAVIGATIONS: readonly Kind[] = [
  { name: 'follow (a link from mail)', run: (b) => b.follow(TARGET), cookies: ['strict', 'lax', 'none'], origin: undefined, fetch: [undefined, undefined, undefined] },
  { name: 'follow (a link on a citadel page)', run: (b) => b.follow(TARGET, { referrer: 'http://citadel.test/home' }), cookies: ['strict', 'lax', 'none'], origin: undefined, fetch: [undefined, undefined, undefined] },
  { name: 'submit (a form on a citadel page)', run: (b) => b.submit(TARGET, { email: 'x' }), cookies: ['strict', 'lax', 'none'], origin: 'http://citadel.test', fetch: [undefined, undefined, undefined] },
  { name: 'crossSiteLink (a link on your page: top-level GET)', run: (b) => b.crossSiteLink(TARGET), cookies: ['lax', 'none'], origin: undefined, fetch: ['cross-site', 'navigate', 'document'] },
  { name: 'crossSitePost (your page\'s form: top-level POST)', run: (b) => b.crossSitePost(TARGET, { email: 'x' }), cookies: ['none'], origin: 'http://attacker.test', fetch: ['cross-site', 'navigate', 'document'] },
  { name: 'crossSiteLink from a sandboxed frame (navigates the frame)', run: (b) => b.crossSiteLink(TARGET, { page: { sandboxed: true } }), cookies: ['none'], origin: undefined, fetch: ['cross-site', 'navigate', 'iframe'] },
  { name: 'crossSitePost from a sandboxed frame', run: (b) => b.crossSitePost(TARGET, { email: 'x' }, { page: { sandboxed: true } }), cookies: ['none'], origin: 'null', fetch: ['cross-site', 'navigate', 'iframe'] },
];

describe('requests across sites: cookies, Origin and Sec-Fetch per kind of request', () => {
  it.each(NAVIGATIONS.map((k) => [k.name, k] as const))('%s', (_name, k) => {
    const v = victim();
    k.run(v.b);
    expect(v.seen).toHaveLength(1);
    expect(sentCookies(v.seen[0]), 'cookies').toEqual(k.cookies);
    expect(v.seen[0].headers.origin, 'origin').toBe(k.origin);
    expect(fetchMeta(v.seen[0]), 'sec-fetch-*').toEqual(k.fetch);
  });

  it('the victim\'s own navigations keep their headers: a GET has only host and user-agent (and its cookies)', () => {
    const v = victim();
    v.b.cookies.clear();
    v.b.follow(TARGET);
    expect(v.seen[0].headers).toEqual({ host: 'citadel.test', 'user-agent': expect.any(String) });
    expect(v.seen[0].rawBody).toBe('');
    v.b.submit(TARGET, { a: '1' }, { referrer: 'http://citadel.test/form' });
    expect(v.seen[1].headers).toEqual({
      host: 'citadel.test', 'user-agent': expect.any(String), referer: 'http://citadel.test/form',
      'content-type': 'application/x-www-form-urlencoded', origin: 'http://citadel.test', // a POST carries Origin, same-site too
    });
    expect(v.seen[1].rawBody).toBe('a=1');
    v.b.submit(TARGET, { a: '1' }, { referrer: 'https://citadel.test/form' }); // an https page posting to http: a downgrade
    expect([v.seen[2].headers.referer, v.seen[2].headers.origin]).toEqual([undefined, 'null']);
  });

  it('the attacker page must be on attacker.test (any subdomain, any port); its URL decides Origin and Referer', () => {
    const v = victim();
    for (const url of ['http://citadel.test/', 'http://example.com/', 'javascript:alert(1)', 'http://attacker.test.citadel.test/']) {
      expect(() => v.b.crossSitePost(TARGET, {}, { page: { url } }), url).toThrow(/attacker page must be on attacker\.test/);
      expect(() => v.b.crossSiteLink(TARGET, { page: { url } }), url).toThrow(/attacker page must be on attacker\.test/);
    }
    expect(() => v.b.crossSiteLink(TARGET, { page: 'http://attacker.test/' as never })).toThrow(/page must be/);
    v.b.crossSitePost(TARGET, {}, { page: { url: 'http://citadel.test.attacker.test:8080/x?citadel=1#frag' } });
    expect(v.seen[0].headers.origin).toBe('http://citadel.test.attacker.test:8080');
    expect(v.seen[0].headers.referer).toBe('http://citadel.test.attacker.test:8080/'); // Chrome's default policy: the origin only
    expect(v.seen).toHaveLength(1);
  });
});

describe('requests across sites: Referer and Origin under the attacker page\'s referrer policy', () => {
  const PAGE = 'http://attacker.test/citadel/forms.html?citadel=yes';
  // [policy, Referer, Origin of the form POST]
  const POLICIES: readonly (readonly [string | undefined, string | undefined, string])[] = [
    [undefined, 'http://attacker.test/', 'http://attacker.test'], // strict-origin-when-cross-origin, Chrome's default
    ['strict-origin-when-cross-origin', 'http://attacker.test/', 'http://attacker.test'],
    ['unsafe-url', PAGE, 'http://attacker.test'], // the page can ask for its whole URL to be sent
    ['no-referrer-when-downgrade', PAGE, 'http://attacker.test'],
    ['origin', 'http://attacker.test/', 'http://attacker.test'],
    ['origin-when-cross-origin', 'http://attacker.test/', 'http://attacker.test'],
    ['strict-origin', 'http://attacker.test/', 'http://attacker.test'],
    ['same-origin', undefined, 'null'], // cross-origin: no Referer, and Origin is hidden too (Fetch)
    ['no-referrer', undefined, 'null'], // rel=noreferrer / <meta name=referrer content=no-referrer>: Origin: null
    ['bogus, unsafe-url, also-bogus', PAGE, 'http://attacker.test'], // the last known token wins
    ['bogus', 'http://attacker.test/', 'http://attacker.test'], // none known: the default
  ];

  it.each(POLICIES.map(([p, ref, origin]) => [String(p), p, ref, origin] as const))('%s', (_label, policy, referer, origin) => {
    const v = victim();
    const page = { url: PAGE, ...(policy === undefined ? {} : { referrerPolicy: policy }) };
    v.b.crossSitePost(TARGET, { email: 'x' }, { page });
    v.b.crossSiteLink(TARGET, { page });
    expect([v.seen[0].headers.referer, v.seen[0].headers.origin]).toEqual([referer, origin]);
    expect([v.seen[1].headers.referer, v.seen[1].headers.origin]).toEqual([referer, undefined]); // a GET carries no Origin
  });

  it('an https page posting to http: the strict policies and the legacy one hide Referer and Origin (a downgrade)', () => {
    const v = victim();
    for (const policy of ['strict-origin-when-cross-origin', 'no-referrer-when-downgrade', 'strict-origin', 'unsafe-url']) {
      v.b.crossSitePost(TARGET, {}, { page: { url: 'https://attacker.test/p', referrerPolicy: policy } });
    }
    expect(v.seen.map((r) => [r.headers.referer, r.headers.origin])).toEqual([
      [undefined, 'null'], [undefined, 'null'], [undefined, 'null'], ['https://attacker.test/p', 'https://attacker.test'],
    ]);
  });

  it('a sandboxed frame\'s request still carries the page\'s Referer, but Origin: null', () => {
    const v = victim();
    v.b.crossSitePost(TARGET, {}, { page: { url: PAGE, referrerPolicy: 'unsafe-url', sandboxed: true } });
    expect([v.seen[0].headers.referer, v.seen[0].headers.origin]).toEqual([PAGE, 'null']);
  });
});

describe('requests across sites: redirects and pages that move on', () => {
  it('a cross-site POST answered 303: the GET that follows is a cross-site top-level GET (Lax now sent, Strict still not, no Origin)', () => {
    const v = victim((r) => (r.path === '/account/email' ? { status: 303, headers: { location: '/account' } } : { status: 200, body: 'Account' }));
    const visit = v.b.crossSitePost(TARGET, { email: 'x' });
    expect(visit.outcome).toBe('page');
    expect(v.seen.map((r) => [r.method, sentCookies(r), r.headers.origin, r.headers['sec-fetch-site']])).toEqual([
      ['POST', ['none'], 'http://attacker.test', 'cross-site'],
      ['GET', ['lax', 'none'], undefined, 'cross-site'],
    ]);
    expect(v.seen[1].headers.referer).toBe('http://attacker.test/'); // a redirect keeps the referrer that started it
  });

  it('307 keeps the POST, its body and its Origin; an origin change on the way taints Origin to null (Fetch)', () => {
    const v = victim((r) => (r.url === 'http://citadel.test/a' ? { status: 307, headers: { location: 'https://citadel.test/b' } }
      : r.url === 'https://citadel.test/b' ? { status: 307, headers: { location: 'https://citadel.test/c' } } : { status: 200 }));
    v.b.crossSitePost('http://citadel.test/a', { k: 'v' });
    expect(v.seen.map((r) => [r.url, r.method, r.rawBody, r.headers.origin])).toEqual([
      ['http://citadel.test/a', 'POST', 'k=v', 'http://attacker.test'],
      ['https://citadel.test/b', 'POST', 'k=v', 'null'], // http -> https citadel: another origin, not the initiator's
      ['https://citadel.test/c', 'POST', 'k=v', 'null'],
    ]);
  });

  it('a citadel page that moves on by itself (Refresh) in the top-level window starts a same-site request', () => {
    const v = victim((r) => (r.path === '/account/email' ? { status: 200, headers: { refresh: '0; url=/done' } } : { status: 200 }));
    v.b.crossSitePost(TARGET, { email: 'x' });
    expect(v.seen.map((r) => [r.path, sentCookies(r), r.headers['sec-fetch-site'], r.headers.referer])).toEqual([
      ['/account/email', ['none'], 'cross-site', 'http://attacker.test/'],
      ['/done', ['strict', 'lax', 'none'], 'same-origin', TARGET],
    ]);
  });

  it('a cross-site response that is not a top-level navigation\'s cannot set a Lax cookie; a top-level one can', () => {
    const v = victim(() => ({ status: 200, headers: { 'set-cookie': ['lax2=1; SameSite=Lax', 'none2=1; SameSite=None; Secure'] } }));
    v.b.crossSitePost(TARGET, {}, { page: { sandboxed: true } }); // navigates a frame
    expect(v.b.cookies.list().map((c) => c.name)).toEqual(['strict', 'lax', 'none', 'none2']);
    v.b.crossSitePost(TARGET, {}); // navigates the top-level page
    expect(v.b.cookies.list().map((c) => c.name)).toEqual(['strict', 'lax', 'none', 'none2', 'lax2']);
  });

  it('a form posted to attacker.test is logged with its body and the page\'s Referer; nothing reaches the citadel', () => {
    const v = victim();
    const visit = v.b.crossSitePost('http://attacker.test/collect', { a: '1' }, { page: { url: 'http://attacker.test/p?x=1' } });
    expect(visit.outcome).toBe('attacker');
    expect(v.w.attackerLog.entries().map((h) => [h.method, h.url, h.referer, h.body])).toEqual([['POST', 'http://attacker.test/collect', 'http://attacker.test/p?x=1', 'a=1']]);
    expect(v.seen).toEqual([]);
  });
});

describe('crossSitePost: the form body as a browser encodes it', () => {
  const posted = (form: SimFormFields, contentType?: string): SimRequest => {
    const v = victim();
    v.b.crossSitePost(TARGET, form, contentType === undefined ? {} : { contentType });
    return v.seen[0];
  };

  it('urlencoded (the default): fields in body, the encoded form in rawBody', () => {
    const r = posted({ email: 'pilgrim@citadel.test', note: 'a b&c' });
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(r.rawBody).toBe('email=pilgrim%40citadel.test&note=a+b%26c');
    expect({ ...r.body }).toEqual({ email: 'pilgrim@citadel.test', note: 'a b&c' });
    expect(Object.getPrototypeOf(r.body)).toBeNull();
  });

  it('text/plain: name=value lines, unescaped, so a JSON body can be smuggled in a field name; the app parses none of it', () => {
    const r = posted([['{"notify":"all","pad":"', '"}']], 'text/plain');
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.rawBody).toBe('{"notify":"all","pad":"="}\r\n');
    expect(JSON.parse(r.rawBody)).toEqual({ notify: 'all', pad: '=' });
    expect({ ...r.body }).toEqual({});
  });

  it('multipart/form-data: one part per field (names escaped), a deterministic boundary; the app parses none of it', () => {
    const r = posted([['a"b', '1'], ['c', 'x\ny']], 'multipart/form-data');
    expect(r.headers['content-type']).toBe(`multipart/form-data; boundary=${SIM_FORM_BOUNDARY}`);
    expect(r.rawBody).toBe([
      `--${SIM_FORM_BOUNDARY}`, 'Content-Disposition: form-data; name="a%22b"', '', '1',
      `--${SIM_FORM_BOUNDARY}`, 'Content-Disposition: form-data; name="c"', '', 'x', 'y',
      `--${SIM_FORM_BOUNDARY}--`, '',
    ].join('\r\n'));
    expect({ ...r.body }).toEqual({});
    const clash = posted([['a', SIM_FORM_BOUNDARY]], 'multipart/form-data');
    expect(clash.headers['content-type']).toBe(`multipart/form-data; boundary=${SIM_FORM_BOUNDARY}x`);
  });

  it('an enctype a browser does not know is urlencoded; the known ones match in any case', () => {
    expect(posted({ a: '1' }, 'application/json').headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(posted({ a: '1' }, ' text/plain').headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(posted({ a: '1' }, 'TEXT/Plain').headers['content-type']).toBe('text/plain');
  });

  it('line breaks become CRLF (HTML); pairs keep their order and may repeat (a repeated name keeps its first value in body)', () => {
    const r = posted([['a', 'x\ry'], ['a', '2'], ['b', 'z\n']]);
    expect(r.rawBody).toBe('a=x%0D%0Ay&a=2&b=z%0D%0A');
    expect({ ...r.body }).toEqual({ a: 'x\r\ny', b: 'z\r\n' });
  });

  it('non-string fields are dropped; a form that is not a record or a list of pairs is empty', () => {
    expect(posted({ a: 'x', b: 5 as never }).rawBody).toBe('a=x');
    expect(posted([['a', 'x'], ['b'] as never, 'c' as never]).rawBody).toBe('a=x');
    expect(posted(null as never).rawBody).toBe('');
  });
});

describe('bodyFields: what the app\'s body parsers give the lab', () => {
  it('urlencoded and JSON objects give fields; anything else gives none', () => {
    expect({ ...bodyFields('application/x-www-form-urlencoded; charset=UTF-8', 'a=1&a=2&b=%20') }).toEqual({ a: '1', b: ' ' });
    const json = bodyFields('Application/JSON', '{"notify":"all","n":5,"o":{"x":"y"},"__proto__":"p"}');
    expect(Object.keys(json)).toEqual(['notify', '__proto__']);
    expect(Object.getPrototypeOf(json)).toBeNull();
    for (const [type, raw] of [['application/json', '[1]'], ['application/json', 'nope'], ['application/json', 'null'], ['text/plain', 'a=1'], ['multipart/form-data; boundary=x', 'a=1']]) {
      expect({ ...bodyFields(type, raw) }, `${type} ${raw}`).toEqual({});
    }
  });
});

// --- corsFetch: fetch() from the attacker page -------------------------------------------------------------------

const API = 'http://citadel.test/api/me';
const FETCHES: readonly Kind[] = [
  { name: 'corsFetch GET, credentials: include', run: (b) => b.corsFetch(API, { credentials: 'include' }), cookies: ['none'], origin: 'http://attacker.test', fetch: ['cross-site', 'cors', 'empty'] },
  { name: 'corsFetch POST, credentials: include', run: (b) => b.corsFetch(API, { method: 'POST', credentials: 'include', body: '{}' }), cookies: ['none'], origin: 'http://attacker.test', fetch: ['cross-site', 'cors', 'empty'] },
  { name: 'corsFetch GET, the default credentials (same-origin): no cookies to another origin', run: (b) => b.corsFetch(API), cookies: [], origin: 'http://attacker.test', fetch: ['cross-site', 'cors', 'empty'] },
  { name: 'corsFetch GET, credentials: omit', run: (b) => b.corsFetch(API, { credentials: 'omit' }), cookies: [], origin: 'http://attacker.test', fetch: ['cross-site', 'cors', 'empty'] },
  { name: 'corsFetch from a sandboxed frame', run: (b) => b.corsFetch(API, { credentials: 'include', page: { sandboxed: true } }), cookies: ['none'], origin: 'null', fetch: ['cross-site', 'cors', 'empty'] },
  { name: 'corsFetch under no-referrer: a CORS request still carries its Origin', run: (b) => b.corsFetch(API, { page: { referrerPolicy: 'no-referrer' } }), cookies: [], origin: 'http://attacker.test', fetch: ['cross-site', 'cors', 'empty'] },
];

describe('corsFetch: cookies, Origin and Sec-Fetch', () => {
  it.each(FETCHES.map((k) => [k.name, k] as const))('%s', (_name, k) => {
    const v = victim();
    k.run(v.b);
    expect(v.seen).toHaveLength(1);
    expect(sentCookies(v.seen[0]), 'cookies').toEqual(k.cookies);
    expect(v.seen[0].headers.origin, 'origin').toBe(k.origin);
    expect(fetchMeta(v.seen[0]), 'sec-fetch-*').toEqual(k.fetch);
  });

  it('Referer follows the page\'s policy (the origin only, by default); a GET carries no Content-Type', () => {
    const v = victim();
    v.b.corsFetch(API, { page: { url: 'http://attacker.test/x?y=1' } });
    v.b.corsFetch(API, { page: { url: 'http://attacker.test/x?y=1', referrerPolicy: 'unsafe-url' } });
    v.b.corsFetch(API, { page: { url: 'http://attacker.test/x?y=1', referrerPolicy: 'no-referrer' } });
    expect(v.seen.map((r) => r.headers.referer)).toEqual(['http://attacker.test/', 'http://attacker.test/x?y=1', undefined]);
    expect(v.seen[0].headers['content-type']).toBeUndefined();
  });
});

describe('corsFetch: may the page read the answer? (the CORS check)', () => {
  // [Access-Control-Allow-Origin, Access-Control-Allow-Credentials, credentials, verdict], from http://attacker.test
  type Row = readonly [string | readonly string[] | undefined, string | undefined, 'include' | 'same-origin' | 'omit', string];
  const ROWS: readonly Row[] = [
    [undefined, undefined, 'include', 'no-allow-origin'],
    [undefined, 'true', 'include', 'no-allow-origin'],
    [undefined, undefined, 'omit', 'no-allow-origin'],
    ['*', undefined, 'omit', 'readable'],
    ['*', undefined, 'same-origin', 'readable'],
    ['*', undefined, 'include', 'wildcard-credentials'],
    ['*', 'true', 'include', 'wildcard-credentials'], // * is never a credentialed read, whatever ACAC says
    ['http://attacker.test', undefined, 'omit', 'readable'],
    ['http://attacker.test', undefined, 'same-origin', 'readable'],
    ['http://attacker.test', undefined, 'include', 'no-allow-credentials'],
    ['http://attacker.test', 'true', 'include', 'readable'], // the reflected origin with credentials: total
    ['http://attacker.test', ' true ', 'include', 'readable'], // values arrive trimmed
    ['http://attacker.test', 'TRUE', 'include', 'no-allow-credentials'], // exactly `true`
    ['http://attacker.test', 'false', 'include', 'no-allow-credentials'],
    [' http://attacker.test\t', 'true', 'include', 'readable'],
    ['http://evil.test', 'true', 'include', 'origin-mismatch'],
    ['http://evil.test', undefined, 'omit', 'origin-mismatch'],
    ['HTTP://ATTACKER.TEST', 'true', 'include', 'origin-mismatch'], // byte for byte
    ['http://attacker.test/', 'true', 'include', 'origin-mismatch'],
    ['http://attacker.test:80', 'true', 'include', 'origin-mismatch'],
    ['https://attacker.test', 'true', 'include', 'origin-mismatch'],
    [['http://attacker.test', 'http://attacker.test'], 'true', 'include', 'origin-mismatch'], // two headers: two values
    ['http://attacker.test, http://evil.test', 'true', 'include', 'origin-mismatch'],
    ['null', 'true', 'include', 'origin-mismatch'], // `null` matches only `Origin: null`
  ];

  const answer = (acao: Row[0], acac: Row[1]) => (r: SimRequest): SimResponse => {
    const headers: Record<string, string | readonly string[]> = {};
    if (acao !== undefined) headers['Access-Control-Allow-Origin'] = acao;
    if (acac !== undefined) headers['Access-Control-Allow-Credentials'] = acac;
    return { status: 200, headers, body: JSON.stringify({ user: r.cookies.none === 'n' ? 'citadel_admin' : null, canary: 'CANARY-42' }) };
  };

  it.each(ROWS.map((row) => [JSON.stringify(row), row] as const))('%s', (_label, [acao, acac, credentials, verdict]) => {
    const v = victim(answer(acao, acac));
    const f = v.b.corsFetch(API, { credentials });
    expect(f.verdict).toBe(verdict);
    expect(f.sent).toBe(true);
    expect(v.seen).toHaveLength(1); // sent either way: CORS decides what the page reads, not what the server does
    expect(f.status).toBe(200);
    if (verdict === 'readable') expect(JSON.parse(f.body ?? '')).toMatchObject({ canary: 'CANARY-42' });
    else expect(f.body).toBeUndefined();
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('a sandboxed frame\'s fetch is Origin: null: only ACAO `null` (or `*` without credentials) lets it read', () => {
    for (const [acao, acac, credentials, verdict] of [
      ['null', 'true', 'include', 'readable'], ['*', undefined, 'omit', 'readable'], ['http://attacker.test', 'true', 'include', 'origin-mismatch'],
    ] as const) {
      const v = victim(answer(acao, acac));
      expect(v.b.corsFetch(API, { credentials, page: { sandboxed: true } }).verdict, `${acao} ${credentials}`).toBe(verdict);
    }
  });

  it('a reflected Origin lets any attacker origin read with the admin\'s cookies (only SameSite=None ones go)', () => {
    const v = victim((r) => ({
      status: 200, headers: { 'Access-Control-Allow-Origin': r.headers.origin ?? '', 'Access-Control-Allow-Credentials': 'true' },
      body: `user=${r.cookies.none === 'n' ? 'admin' : 'nobody'}`,
    }));
    const f = v.b.corsFetch(API, { credentials: 'include', page: { url: 'http://citadel.test.attacker.test/' } });
    expect([f.verdict, f.body]).toEqual(['readable', 'user=admin']);
    expect(v.seen[0].headers.origin).toBe('http://citadel.test.attacker.test');
  });

  it('every answer is checked, a redirect too: a redirect without ACAO ends the fetch there (a network error)', () => {
    const allow = { 'Access-Control-Allow-Origin': 'http://attacker.test', 'Access-Control-Allow-Credentials': 'true' };
    const blocked = victim((r) => (r.path === '/api/me' ? { status: 302, headers: { location: '/api/v2/me' } } : { status: 200, headers: allow, body: 'x' }));
    const f = blocked.b.corsFetch(API, { credentials: 'include' });
    expect([f.verdict, f.status, blocked.seen.length]).toEqual(['no-allow-origin', 302, 1]);
    const passed = victim((r) => (r.path === '/api/me' ? { status: 302, headers: { location: '/api/v2/me', ...allow } } : { status: 200, headers: allow, body: 'x' }));
    const g = passed.b.corsFetch(API, { credentials: 'include' });
    expect([g.verdict, g.status, g.body, passed.seen.map((r) => r.path)]).toEqual(['readable', 200, 'x', ['/api/me', '/api/v2/me']]);
  });

  it('a redirect to another origin taints the request: the next one is Origin: null (and so must its ACAO be)', () => {
    const v = victim((r) => (r.url === API ? { status: 307, headers: { location: 'https://citadel.test/api/me', 'Access-Control-Allow-Origin': '*' } }
      : { status: 200, headers: { 'Access-Control-Allow-Origin': r.headers.origin ?? '' }, body: 'y' }));
    const f = v.b.corsFetch(API);
    expect(v.seen.map((r) => r.headers.origin)).toEqual(['http://attacker.test', 'null']);
    expect([f.verdict, f.body]).toEqual(['readable', 'y']);
  });

  it('an answer that is not a citadel page has nothing to read: your own server, an unreachable host', () => {
    const v = victim();
    const own = v.b.corsFetch('http://attacker.test/log', { method: 'POST', body: 'hello' });
    expect([own.sent, own.verdict, own.visit?.outcome]).toEqual([true, 'no-answer', 'attacker']);
    expect(v.w.attackerLog.entries().at(-1)).toMatchObject({ method: 'POST', url: 'http://attacker.test/log', body: 'hello' });
    const lost = v.b.corsFetch('http://127.0.0.1/');
    expect([lost.sent, lost.verdict, lost.visit?.outcome]).toEqual([true, 'no-answer', 'unreachable']);
  });
});

describe('corsFetch: what a page can send without a preflight', () => {
  // [headers, body (POST when given), sent?]
  const CASES: readonly (readonly [string, Record<string, string> | undefined, string | undefined, boolean])[] = [
    ['a GET with no headers', undefined, undefined, true],
    ['a POST with a string body and no Content-Type (text/plain;charset=UTF-8)', undefined, '{"notify":"all"}', true],
    ['Content-Type: text/plain', { 'Content-Type': 'text/plain' }, '{"notify":"all"}', true],
    ['Content-Type: TEXT/Plain;charset=UTF-8', { 'content-type': 'TEXT/Plain;charset=UTF-8' }, 'x', true],
    ['Content-Type: application/x-www-form-urlencoded', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1', true],
    ['Content-Type: multipart/form-data; boundary=x', { 'Content-Type': 'multipart/form-data; boundary=x' }, '--x--', true],
    ['Content-Type: application/json', { 'Content-Type': 'application/json' }, '{"notify":"all"}', false],
    ['Content-Type: text/plain; charset="utf-8" (a quote is a CORS-unsafe byte)', { 'Content-Type': 'text/plain; charset="utf-8"' }, 'x', false],
    ['Content-Type: text/plain garbage (not a MIME type)', { 'Content-Type': 'text/plain garbage' }, 'x', false],
    ['X-Requested-With: XMLHttpRequest (a custom header)', { 'X-Requested-With': 'XMLHttpRequest' }, undefined, false],
    ['Accept: application/json', { Accept: 'application/json' }, undefined, true],
    ['Accept with a CORS-unsafe byte', { Accept: 'text/(html)' }, undefined, false],
    ['Accept over 128 bytes', { Accept: 'a'.repeat(129) }, undefined, false],
    ['Accept-Language: en-US,en;q=0.9', { 'Accept-Language': 'en-US,en;q=0.9' }, undefined, true],
    ['Accept-Language with an @', { 'Accept-Language': 'en@x' }, undefined, false],
    ['Content-Language: id', { 'Content-Language': 'id' }, undefined, true],
    ['Range (treated as not safelisted)', { Range: 'bytes=0-1' }, undefined, false],
  ];

  it.each(CASES.map(([name, headers, body, sent]) => [name, headers, body, sent] as const))('%s', (_name, headers, body, sent) => {
    const v = victim();
    const f = v.b.corsFetch(API, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST' as const, body }), ...(headers ? { headers } : {}) });
    expect(f.sent).toBe(sent);
    expect(v.seen).toHaveLength(sent ? 1 : 0);
    if (!sent) expect([f.verdict, f.visit]).toEqual(['preflight', undefined]);
  });

  it('a JSON body sent as text/plain reaches the handler whole in rawBody; the app\'s parsers give no fields', () => {
    const v = victim();
    v.b.corsFetch('http://citadel.test/account/prefs', { method: 'POST', credentials: 'include', body: '{"notify":"all"}' });
    expect(v.seen[0]).toMatchObject({ method: 'POST', rawBody: '{"notify":"all"}', headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    expect({ ...v.seen[0].body }).toEqual({});
    v.b.corsFetch('http://citadel.test/account/prefs', { method: 'POST', body: 'notify=all', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect({ ...v.seen[1].body }).toEqual({ notify: 'all' });
  });

  it('forbidden headers are dropped, as fetch() drops them: the page cannot forge Cookie, Origin, Referer or Sec-*', () => {
    const v = victim();
    const f = v.b.corsFetch(API, {
      credentials: 'include',
      headers: { Cookie: 'strict=forged', Origin: 'http://citadel.test', Referer: 'http://citadel.test/', 'Sec-Fetch-Site': 'same-origin', 'Proxy-Auth': 'x', Host: 'evil', 'Accept-Encoding': 'x', DNT: '1' },
    });
    expect(f.sent).toBe(true); // nothing left that needs a preflight
    expect(v.seen[0].headers).toEqual({
      host: 'citadel.test', 'user-agent': expect.any(String), referer: 'http://attacker.test/', cookie: 'none=n', origin: 'http://attacker.test',
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    });
  });

  it('safelisted headers the page sets reach the handler, trimmed and lower-cased; a name given twice is combined', () => {
    const v = victim();
    v.b.corsFetch(API, { headers: { Accept: ' text/html ', accept: 'application/json', 'Accept-Language': 'id' } });
    expect(v.seen[0].headers).toMatchObject({ accept: 'text/html, application/json', 'accept-language': 'id' });
  });

  it('fetch() throws before sending (verdict invalid): a GET with a body, a header name that is no token, a CR, LF or NUL in a value', () => {
    const v = victim();
    for (const opts of [
      { body: 'x' }, { headers: { 'bad name': 'x' } }, { headers: { Accept: 'a\nb' } }, { headers: { Accept: 'a\rb' } }, { headers: { Accept: 'a\0b' } },
      { headers: { Accept: 5 as never } }, { headers: [['Accept', 'x']] as never },
    ]) {
      expect(v.b.corsFetch(API, opts as never), JSON.stringify(opts)).toEqual({ sent: false, verdict: 'invalid' });
    }
    expect(v.seen).toEqual([]);
  });

  it('a request to your own server needs no preflight check here: it is logged as sent', () => {
    const v = victim();
    const f = v.b.corsFetch('http://attacker.test/x', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect([f.sent, f.verdict]).toEqual([true, 'no-answer']);
    expect(v.w.attackerLog.entries()).toHaveLength(1);
  });

  it('a lab bug is an error: an unknown method or credentials mode, a body that is not a string', () => {
    const v = victim();
    expect(() => v.b.corsFetch(API, { method: 'PUT' as never })).toThrow(/method must be 'GET' or 'POST'/);
    expect(() => v.b.corsFetch(API, { credentials: 'all' as never })).toThrow(/credentials must be/);
    expect(() => v.b.corsFetch(API, { method: 'POST', body: 5 as never })).toThrow(/body must be a string/);
    expect(() => v.b.corsFetch(API, { page: { url: 'http://citadel.test/' } })).toThrow(/attacker page must be on attacker\.test/);
  });
});

describe('corsFetch: a fetch is not a navigation', () => {
  it('a Refresh on the answer is not followed; redirects are, and a 303 drops the body and its Content-Type', () => {
    const acao = { 'Access-Control-Allow-Origin': '*' }; // the redirect passes the CORS check too
    const v = victim((r) => (r.path === '/a' ? { status: 303, headers: { location: '/b', ...acao } } : { status: 200, headers: { refresh: '0; url=/c', ...acao } }));
    const f = v.b.corsFetch('http://citadel.test/a', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'text/plain', 'Content-Language': 'id', Accept: 'x' } });
    expect(v.seen.map((r) => [r.path, r.method, r.rawBody, r.headers['content-type'], r.headers['content-language'], r.headers.accept])).toEqual([
      ['/a', 'POST', 'x=1', 'text/plain', 'id', 'x'], ['/b', 'GET', '', undefined, undefined, 'x'],
    ]);
    expect(f.visit?.hops).toHaveLength(2);
  });

  it('cookies: an answer to a credentialed fetch stores only SameSite=None ones; without credentials it stores none', () => {
    const lines = ['lax2=1; SameSite=Lax', 'none2=1; SameSite=None; Secure'];
    const v = victim(() => ({ status: 200, headers: { 'set-cookie': lines } }));
    v.b.corsFetch(API);
    expect(v.b.cookies.list().map((c) => c.name)).toEqual(['strict', 'lax', 'none']);
    v.b.corsFetch(API, { credentials: 'include' });
    expect(v.b.cookies.list().map((c) => c.name)).toEqual(['strict', 'lax', 'none', 'none2']);
  });

  it('the visit is recorded like any other; a fetch that is not sent records none', () => {
    const v = victim();
    v.b.corsFetch(API);
    v.b.corsFetch(API, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    expect(v.w.visits.map((x) => [x.outcome, x.hops.length])).toEqual([['page', 1]]);
  });
});

// --- frame and clickThrough: clickjacking ------------------------------------------------------------------------

const GRANT = 'http://citadel.test/moderation/grant';

describe('frame: may the citadel page be shown in the attacker\'s frame? (X-Frame-Options, CSP frame-ancestors)', () => {
  type Headers = Record<string, string | readonly string[]>;
  // [response headers, framing page URL (default http://attacker.test/), verdict]
  const ROWS: readonly (readonly [Headers, string | undefined, string])[] = [
    [{}, undefined, 'allowed'], // no framing header at all (FP-04 Acolyte)
    [{ 'X-Frame-Options': 'DENY' }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': 'deny' }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': ' DENY ' }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': 'SAMEORIGIN' }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': 'SAMEORIGIN' }, 'http://citadel.attacker.test/', 'x-frame-options'],
    [{ 'X-Frame-Options': 'ALLOW-FROM http://attacker.test/' }, undefined, 'allowed'], // unsupported: browsers ignore it
    [{ 'X-Frame-Options': 'ALLOWALL' }, undefined, 'allowed'],
    [{ 'X-Frame-Options': 'garbage' }, undefined, 'allowed'],
    [{ 'X-Frame-Options': '' }, undefined, 'allowed'],
    [{ 'X-Frame-Options': 'DENY, SAMEORIGIN' }, undefined, 'x-frame-options'], // conflicting values refuse
    [{ 'X-Frame-Options': ['DENY', 'DENY'] }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': 'SAMEORIGIN, ALLOWALL' }, undefined, 'x-frame-options'],
    [{ 'X-Frame-Options': 'foo, bar' }, undefined, 'allowed'], // several unknown values allow
    [{ 'Content-Security-Policy': "frame-ancestors 'none'" }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': "FRAME-ANCESTORS 'NONE'" }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': 'frame-ancestors' }, undefined, 'frame-ancestors'], // an empty list matches nothing
    [{ 'Content-Security-Policy': "frame-ancestors 'self'" }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': 'frame-ancestors *' }, undefined, 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test' }, undefined, 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors attacker.test' }, undefined, 'allowed'], // no scheme: the page's (http)
    [{ 'Content-Security-Policy': 'frame-ancestors attacker.test' }, 'https://attacker.test/', 'allowed'], // http lets https in
    [{ 'Content-Security-Policy': 'frame-ancestors https://attacker.test' }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': 'frame-ancestors http:' }, undefined, 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors https:' }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': 'frame-ancestors *.attacker.test' }, undefined, 'frame-ancestors'], // not the apex
    [{ 'Content-Security-Policy': 'frame-ancestors *.attacker.test' }, 'http://x.attacker.test/', 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test:8080' }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test:8080' }, 'http://attacker.test:8080/', 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test:*' }, 'http://attacker.test:8080/', 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test:80' }, undefined, 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test/' }, undefined, 'allowed'],
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test/x' }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': "frame-ancestors 'none' http://attacker.test" }, undefined, 'allowed'], // 'none' counts only alone
    [{ 'Content-Security-Policy': "frame-ancestors 'unsafe-inline'" }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': "script-src 'self'; frame-ancestors 'none'" }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy': "frame-ancestors *; frame-ancestors 'none'" }, undefined, 'allowed'], // a repeat is ignored
    [{ 'Content-Security-Policy': ['frame-ancestors *', "frame-ancestors 'self'"] }, undefined, 'frame-ancestors'], // both apply
    [{ 'Content-Security-Policy': "frame-ancestors *, frame-ancestors 'self'" }, undefined, 'frame-ancestors'], // two policies
    [{ 'Content-Security-Policy': "default-src 'none'" }, undefined, 'allowed'], // no frame-ancestors: X-Frame-Options decides
    [{ 'Content-Security-Policy': "default-src 'none'", 'X-Frame-Options': 'DENY' }, undefined, 'x-frame-options'],
    [{ 'Content-Security-Policy': 'frame-ancestors *', 'X-Frame-Options': 'DENY' }, undefined, 'allowed'], // frame-ancestors wins
    [{ 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'ALLOWALL' }, undefined, 'frame-ancestors'],
    [{ 'Content-Security-Policy-Report-Only': "frame-ancestors 'none'" }, undefined, 'allowed'], // reports, enforces nothing
    [{ 'Content-Security-Policy': 'frame-ancestors http://attacker.test', 'X-Frame-Options': 'DENY' }, undefined, 'allowed'],
  ];

  it.each(ROWS.map((row) => [JSON.stringify(row), row] as const))('%s', (_label, [headers, pageUrl, verdict]) => {
    const v = victim(() => ({ status: 200, headers, body: 'Approve this moderator request? [Approve]' }));
    const f = v.b.frame(GRANT, pageUrl === undefined ? {} : { page: { url: pageUrl } });
    expect(f.reason).toBe(verdict);
    expect(f.framed).toBe(verdict === 'allowed');
    expect(v.seen).toHaveLength(1); // the request is sent either way; the page decides whether it is shown
    if (f.framed) expect(f.page).toMatchObject({ url: GRANT, status: 200 });
    else expect(f.page).toBeUndefined();
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('framingOf: SAMEORIGIN and \'self\' let a same-origin (or https-upgraded) ancestor frame the page', () => {
    const page = classifySimUrl('http://citadel.test/p');
    const h = (k: string, val: string) => new Map([[k, [val]]]);
    expect(framingOf(h('x-frame-options', 'SAMEORIGIN'), page, [classifySimUrl('http://citadel.test/')])).toBe('allowed');
    expect(framingOf(h('x-frame-options', 'SAMEORIGIN'), page, [classifySimUrl('http://citadel.test/'), classifySimUrl('http://attacker.test/')])).toBe('x-frame-options');
    expect(framingOf(h('content-security-policy', "frame-ancestors 'self'"), page, [classifySimUrl('http://citadel.test/')])).toBe('allowed');
    expect(framingOf(h('content-security-policy', "frame-ancestors 'self'"), page, [classifySimUrl('https://citadel.test/')])).toBe('allowed');
    expect(framingOf(h('content-security-policy', "frame-ancestors 'self'"), classifySimUrl('https://citadel.test/p'), [classifySimUrl('http://citadel.test/')])).toBe('frame-ancestors');
  });

  it('a <meta> tag in the body sets nothing: only response headers count', () => {
    const v = victim(() => ({ status: 200, body: '<meta http-equiv="X-Frame-Options" content="DENY"><meta http-equiv="Content-Security-Policy" content="frame-ancestors \'none\'">' }));
    expect(v.b.frame(GRANT).framed).toBe(true);
  });
});

describe('frame: the frame\'s requests', () => {
  it('a GET navigation of a frame: only SameSite=None cookies (the top-level page is the attacker\'s), no Origin, Sec-Fetch-Dest iframe', () => {
    const v = victim();
    v.b.frame(GRANT, { page: { url: 'http://attacker.test/decoy.html', referrerPolicy: 'unsafe-url' } });
    expect(sentCookies(v.seen[0])).toEqual(['none']);
    expect(v.seen[0].headers.origin).toBeUndefined();
    expect(fetchMeta(v.seen[0])).toEqual(['cross-site', 'navigate', 'iframe']);
    expect(v.seen[0].headers.referer).toBe('http://attacker.test/decoy.html');
  });

  it('a signed-in admin with a Lax (or Strict) session is signed OUT inside the frame: clickjacking needs SameSite=None', () => {
    const v = victim((r) => ({ status: 200, body: r.cookies.lax === 'l' || r.cookies.strict === 's' ? 'Signed in' : 'Please sign in' }));
    const f = v.b.frame(GRANT);
    expect([f.framed, f.page?.body]).toEqual([true, 'Please sign in']);
  });

  it('redirects are followed and only the page shown is checked: a framing header on a redirect does not count', () => {
    const v = victim((r) => (r.path === '/moderation/grant' ? { status: 302, headers: { location: '/moderation/confirm', 'X-Frame-Options': 'DENY' } } : { status: 200 }));
    const f = v.b.frame(GRANT);
    expect([f.framed, f.page?.url]).toEqual([true, 'http://citadel.test/moderation/confirm']);
  });

  it('a shown page that moves on (Refresh) navigates the frame; a page that refuses the frame is not shown, so it never moves on', () => {
    const moving = victim((r) => (r.path === '/moderation/grant' ? { status: 200, headers: { refresh: '0; url=/moderation/confirm' } } : { status: 200 }));
    const f = moving.b.frame(GRANT);
    expect([f.framed, f.page?.url]).toEqual([true, 'http://citadel.test/moderation/confirm']);
    expect(moving.seen.map((r) => [r.path, sentCookies(r), r.headers['sec-fetch-site'], r.headers.referer])).toEqual([
      ['/moderation/grant', ['none'], 'cross-site', 'http://attacker.test/'],
      ['/moderation/confirm', ['none'], 'same-origin', GRANT], // started by the framed citadel page; still cross-site for cookies
    ]);
    const refused = victim((r) => (r.path === '/moderation/grant' ? { status: 200, headers: { refresh: '0; url=/moderation/confirm', 'X-Frame-Options': 'DENY' } } : { status: 200 }));
    const g = refused.b.frame(GRANT);
    expect([g.framed, g.reason, refused.seen.length]).toEqual([false, 'x-frame-options', 1]);
  });

  it('a frame of your own server or an unreachable host shows no citadel page (not-loaded); your server logs the request', () => {
    const v = victim();
    const own = v.b.frame('http://attacker.test/inner');
    expect([own.framed, own.reason, own.visit.outcome]).toEqual([false, 'not-loaded', 'attacker']);
    expect(v.w.attackerLog.entries()[0]).toMatchObject({ method: 'GET', url: 'http://attacker.test/inner', referer: 'http://attacker.test/' });
    expect(v.b.frame('http://127.0.0.1/').reason).toBe('not-loaded');
  });

  it('the framing page must be on attacker.test; a sandboxed framing page is not modelled', () => {
    const v = victim();
    expect(() => v.b.frame(GRANT, { page: { url: 'http://citadel.test/' } })).toThrow(/attacker page must be on attacker\.test/);
    expect(() => v.b.frame(GRANT, { page: { sandboxed: true } as never })).toThrow(/sandboxed framing page is not modelled/);
  });
});

describe('clickThrough: the admin clicks your decoy over the framed page\'s button', () => {
  it('submits the framed page\'s form inside the frame: Origin citadel, Sec-Fetch-Site same-origin, but only SameSite=None cookies', () => {
    const v = victim();
    const f = v.b.frame('http://citadel.test/moderation/confirm?id=7');
    const c = v.b.clickThrough(f, '/moderation/grant', { user: 'pilgrim', token: 't1' });
    expect(c.clicked).toBe(true);
    expect(c.visit?.outcome).toBe('page');
    const post = v.seen[1];
    expect([post.method, post.url, post.rawBody, { ...post.body }]).toEqual(['POST', GRANT, 'user=pilgrim&token=t1', { user: 'pilgrim', token: 't1' }]);
    expect(sentCookies(post)).toEqual(['none']); // contrast FP-01/02's cross-site form: same verdict for cookies, other headers
    expect(post.headers.origin).toBe('http://citadel.test');
    expect(fetchMeta(post)).toEqual(['same-origin', 'navigate', 'iframe']);
    expect(post.headers.referer).toBe('http://citadel.test/moderation/confirm?id=7'); // the framed page, under its own policy
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('the framed page\'s Referrer-Policy governs the click\'s Referer (and Origin); its enctype is the form\'s', () => {
    const v = victim((r) => ({ status: 200, headers: r.method === 'GET' ? { 'Referrer-Policy': 'no-referrer' } : {} }));
    const f = v.b.frame('http://citadel.test/moderation/confirm');
    v.b.clickThrough(f, 'http://citadel.test/moderation/grant', [['user', 'pilgrim']], { contentType: 'text/plain' });
    expect([v.seen[1].headers.referer, v.seen[1].headers.origin, v.seen[1].headers['content-type'], v.seen[1].rawBody])
      .toEqual([undefined, 'null', 'text/plain', 'user=pilgrim\r\n']);
  });

  it('nothing is sent when the frame shows no citadel page: the click lands on your decoy alone', () => {
    const v = victim(() => ({ status: 200, headers: { 'X-Frame-Options': 'DENY' } }));
    const f = v.b.frame(GRANT);
    expect(v.b.clickThrough(f, '/moderation/grant', { user: 'pilgrim' })).toEqual({ clicked: false });
    expect(v.seen).toHaveLength(1);
    const own = v.b.frame('http://attacker.test/');
    expect(v.b.clickThrough(own, '/x', {})).toEqual({ clicked: false });
  });

  it('the answer to the click is sent even when it may not be framed itself (the action ran; the frame shows nothing)', () => {
    const v = victim((r) => (r.method === 'POST' ? { status: 200, headers: { 'X-Frame-Options': 'DENY', refresh: '0; url=/after' } } : { status: 200 }));
    const c = v.b.clickThrough(v.b.frame('http://citadel.test/moderation/confirm'), '/moderation/grant', {});
    expect([c.clicked, v.seen.map((r) => r.path)]).toEqual([true, ['/moderation/confirm', '/moderation/grant']]);
  });

  it('only a frame this browser loaded can be clicked', () => {
    const v = victim();
    const other = victim();
    const f = other.b.frame(GRANT);
    expect(() => v.b.clickThrough(f, '/x', {})).toThrow(/a frame this browser loaded/);
    expect(() => v.b.clickThrough({ ...f }, '/x', {})).toThrow(/a frame this browser loaded/);
    expect(() => v.b.clickThrough(null as never, '/x', {})).toThrow(/a frame this browser loaded/);
  });
});

