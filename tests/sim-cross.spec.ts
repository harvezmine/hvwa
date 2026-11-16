// The simulated victim across sites (engine task E1, docs/RECIPES.md section 8 "Across sites"): the SameSite jar,
// Origin / Sec-Fetch shaping, CORS reads, framing, and the attacker-page presets. Everything is in process: no HTTP,
// no socket (the guard in tests/sim.spec.ts covers src/core/sim/ as a whole).
import { describe, expect, it } from 'vitest';
import { perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { Jar, sameSiteSends, sameSiteStores, type SimCookieContext, type SimSameSite } from '../src/core/sim/cookies.js';
import { bodyFields } from '../src/core/sim/cross.js';
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
