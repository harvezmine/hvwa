// The XSS sink interpreter (core/victim.ts xssBrowser): the simulated admin "views" a citadel page, the static oracle
// decides whether the page's script would have run the player's marker, and if so the admin's stolen canary lands in
// the player's attacker log. In process; no HTTP (the fixture lab in tests/xss-lab.spec.ts drives the real app).
import { describe, expect, it } from 'vitest';
import { cappedBudgetUsage, perSession } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { ADMIN_MAILBOX, SIM_LIMITS, simWorld, type SimRequest, type SimResponse, type SimWorld } from '../src/core/sim.js';
import {
  XSS_LIMITS, XSS_STEAL_URL, markerCall, newMarker, xssBrowser, type XssBrowser, type XssMarker, type XssPage, type XssVictimOptions,
} from '../src/core/xss.js';

/** A full GC: vitest.config.ts starts the test workers with --expose-gc. */
function fullGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
  return gc;
}

type Route = SimResponse | ((r: SimRequest) => SimResponse);
interface Lab { readonly world: SimWorld; readonly marker: XssMarker; readonly admin: XssBrowser; readonly seen: SimRequest[] }

let n = 0;
/** One player's lab at one level, built as a lab must: inside a perSession factory. Routes see the player's marker. */
function lab(routes: (m: string) => Record<string, Route>, opts: Partial<XssVictimOptions> = {}, level: Level = 'acolyte'): Lab {
  return perSession((): Lab => {
    const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
    const marker = newMarker();
    const table = routes(marker.call);
    const seen: SimRequest[] = [];
    const admin = xssBrowser(world, (r) => {
      seen.push(r);
      const route = table[r.path];
      if (route === undefined) return { status: 404, body: 'Not found' };
      return typeof route === 'function' ? route(r) : route;
    }, { marker: marker.call, canary: 'ADMIN-CANARY', ...opts });
    return { world, marker, admin, seen };
  }).for({ sessionId: `xss-victim-${++n}`, level });
}
const page = (body: string, headers: Record<string, string | string[]> = {}): SimResponse => ({ status: 200, headers, body });
/** The requests the payload's script sent home. */
const steals = (l: Lab): string[] => l.world.attackerLog.entries().filter((h) => h.url.startsWith(XSS_STEAL_URL)).map((h) => h.url);
const STOLEN = `${XSS_STEAL_URL}?c=ADMIN-CANARY`;

describe('newMarker: one marker per player and level', () => {
  it('is made only inside a perSession factory (never shared at module level)', () => {
    expect(() => newMarker()).toThrow(/perSession/);
  });

  it('is a fresh 16-hex nonce and its call, frozen; players and levels get their own', () => {
    const holder = perSession(() => newMarker());
    const a = holder.for({ sessionId: 'marker-a', level: 'acolyte' });
    expect(a.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(a.call).toBe(markerCall(a.nonce));
    expect(Object.isFrozen(a)).toBe(true);
    expect(holder.for({ sessionId: 'marker-a', level: 'acolyte' })).toBe(a);
    const others = [holder.for({ sessionId: 'marker-b', level: 'acolyte' }), holder.for({ sessionId: 'marker-a', level: 'templar' })];
    for (const o of others) expect(o.nonce).not.toBe(a.nonce);
  });
});

describe('xssBrowser: the admin views a page; the oracle decides whether the payload ran', () => {
  it('a page whose payload runs: the admin\'s canary reaches the attacker log, once per page; the visit ends on the page', () => {
    const l = lab((m) => ({ '/search': page(`<p>No scrolls match <b><img src=x onerror=${m}><svg onload=${m}></b></p>`) }));
    const visit = l.admin.follow('http://citadel.test/search?q=x');
    expect(visit.outcome).toBe('page');
    expect(steals(l)).toEqual([STOLEN]);
    expect(l.world.attackerLog.entries()[0]).toMatchObject({ method: 'GET', url: STOLEN });
    expect(l.world.attackerLog.entries()[0].referer).toBeUndefined();
    l.admin.follow('http://citadel.test/search?q=again');
    expect(steals(l)).toEqual([STOLEN, STOLEN]);
    expect(l.admin.verdicts.at(-1)).toMatchObject({ url: 'http://citadel.test/search?q=again', fired: true, page: { executes: true } });
  });

  it('an escaped page, or one with another player\'s marker, sends nothing; the verdict says the marker was seen as text', () => {
    const other = markerCall('fedcba9876543210');
    const l = lab((m) => ({ '/escaped': page(`&lt;script&gt;${m}&lt;/script&gt;`), '/other': page(`<img src=x onerror=${other}>`) }));
    l.admin.follow('http://citadel.test/escaped');
    l.admin.follow('http://citadel.test/other');
    expect(steals(l)).toEqual([]);
    expect(l.admin.verdicts.map((v) => [v.fired, v.page.executes, v.page.reachedMarker])).toEqual([[false, false, true], [false, false, false]]);
  });

  it('isolates players: the same payload fires only in the session whose marker it carries', () => {
    let carried = '';
    const a = lab((m) => { carried = m; return { '/p': () => page(`<img src=x onerror=${carried}>`) }; });
    const b = lab(() => ({ '/p': () => page(`<img src=x onerror=${carried}>`) }));
    a.admin.follow('http://citadel.test/p');
    b.admin.follow('http://citadel.test/p');
    expect(steals(a)).toEqual([STOLEN]);
    expect(steals(b)).toEqual([]);
    expect(a.marker.nonce).not.toBe(b.marker.nonce);
  });

  it('the canary is read when the payload runs: a signed-out admin has nothing to steal; it is URL-encoded', () => {
    let session: string | undefined = 'a b&c=d';
    const l = lab((m) => ({ '/p': page(`<img src=x onerror=${m}>`) }), { canary: () => session ?? '' });
    l.admin.follow('http://citadel.test/p');
    session = undefined;
    l.admin.follow('http://citadel.test/p');
    expect(steals(l)).toEqual([`${XSS_STEAL_URL}?c=a%20b%26c%3Dd`, `${XSS_STEAL_URL}?c=`]);
  });

  it('a redirect is not a page (its body never renders); the page it leads to is', () => {
    const l = lab((m) => ({
      '/go': { status: 302, headers: { Location: '/land' }, body: `<script>${m}</script>` },
      '/odd': { status: 300, headers: { Location: '/land' }, body: `<script>${m}</script>` }, // not followed: a page
      '/land': page('<p>landed</p>'),
    }));
    l.admin.follow('http://citadel.test/go');
    expect(steals(l)).toEqual([]);
    expect(l.admin.verdicts.map((v) => v.url)).toEqual(['http://citadel.test/land']);
    l.admin.follow('http://citadel.test/odd');
    expect(steals(l)).toEqual([STOLEN]);
  });

  it('a page that moves on by itself (Refresh) renders first, and so does the next one', () => {
    const l = lab((m) => ({ '/a': page(`<img src=x onerror=${m}>`, { Refresh: '0; url=/b' }), '/b': page(`<svg onload=${m}>`) }));
    expect(l.admin.follow('http://citadel.test/a').hops).toHaveLength(2);
    expect(steals(l)).toEqual([STOLEN, STOLEN]);
  });

  it('only what a browser renders as a document runs: HTML, XHTML, SVG, XML, or no type; never a download', () => {
    const svg = (m: string) => `<svg xmlns="http://www.w3.org/2000/svg" onload="${m}"/>`;
    const cases: [Record<string, string>, boolean][] = [
      [{}, true], [{ 'Content-Type': 'text/html; charset=utf-8' }, true], [{ 'content-type': 'image/svg+xml' }, true],
      [{ 'Content-Type': 'application/xhtml+xml' }, true], [{ 'Content-Type': 'text/plain' }, false], [{ 'Content-Type': 'application/json' }, false],
      [{ 'Content-Type': 'application/octet-stream' }, false], [{ 'Content-Type': 'image/png' }, false],
      [{ 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'attachment; filename="sigil.svg"' }, false],
      [{ 'Content-Disposition': 'ATTACHMENT' }, false], [{ 'Content-Disposition': 'inline' }, true],
    ];
    for (const [headers, fires] of cases) {
      const l = lab((m) => ({ '/sigil': page(svg(m), headers) }));
      l.admin.follow('http://citadel.test/sigil');
      expect(steals(l).length, JSON.stringify(headers)).toBe(fires ? 1 : 0);
    }
  });

  it('an XML type is read as XML (FP2): no SVG namespace or a not-well-formed root runs nothing; text/html is HTML', () => {
    const cases: [string, Record<string, string>, boolean][] = [
      ['<svg xmlns="http://www.w3.org/2000/svg" onload="M"/>', { 'Content-Type': 'image/svg+xml' }, true],
      ['<svg onload="M"/>', { 'Content-Type': 'image/svg+xml' }, false], // no xmlns: not SVG at all
      ['<svg xmlns="http://www.w3.org/2000/svg" onload=M/>', { 'Content-Type': 'image/svg+xml' }, false], // unquoted: not well-formed
      ['<svg xmlns="http://www.w3.org/2000/svg"><img src="x" onerror="M"/></svg>', { 'Content-Type': 'image/svg+xml' }, false],
      ['<svg onload=M>', { 'Content-Type': 'text/html' }, true], ['<svg onload=M>', {}, true],
      ['<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="x" onerror="M"/></body></html>', { 'Content-Type': 'application/xhtml+xml' }, true],
    ];
    for (const [body, headers, fires] of cases) {
      const l = lab((m) => ({ '/sigil': page(body.replace('M', m), headers) }));
      l.admin.follow('http://citadel.test/sigil');
      expect(steals(l).length, `${JSON.stringify(headers)} ${body}`).toBe(fires ? 1 : 0);
    }
    // A DOCTYPE that declares entities or attribute defaults is refused, not judged: the verdict says so.
    const dtd = lab((m) => ({ '/sigil': page(`<!DOCTYPE svg [<!ATTLIST svg onload CDATA "${m}">]><svg xmlns="http://www.w3.org/2000/svg"/>`, { 'Content-Type': 'image/svg+xml' }) }));
    dtd.admin.follow('http://citadel.test/sigil');
    expect(steals(dtd)).toEqual([]);
    expect(dtd.admin.verdicts[0].page).toMatchObject({ executes: false, limited: 'dtd' });
  });

  it('a CSP sandbox on the response applies (no allow-scripts: nothing runs; no allow-same-origin: nothing reaches the admin\'s cookie)', () => {
    const cases: [string | string[], boolean][] = [
      ['sandbox', false], ['sandbox allow-scripts', false], ["default-src 'none'; sandbox allow-scripts allow-same-origin", true],
      [['sandbox allow-scripts allow-same-origin', 'sandbox allow-scripts'], false], // two policies: both apply
      ["script-src 'self'", true], // only sandbox is modelled: a Divine level escapes, it does not lean on CSP
    ];
    for (const [csp, fires] of cases) {
      const l = lab((m) => ({ '/p': page(`<img src=x onerror=${m}>`, { 'Content-Security-Policy': csp }) }));
      l.admin.follow('http://citadel.test/p');
      expect(steals(l).length, String(csp)).toBe(fires ? 1 : 0);
    }
  });

  it('interact: false counts only what fires by itself', () => {
    const hover = lab((m) => ({ '/p': page(`<b onmouseover=${m}>x</b>`) }), { interact: false });
    hover.admin.follow('http://citadel.test/p');
    expect(steals(hover)).toEqual([]);
    const reads = lab((m) => ({ '/p': page(`<b onmouseover=${m}>x</b>`) }));
    reads.admin.follow('http://citadel.test/p');
    expect(steals(reads)).toEqual([STOLEN]);
  });

  it(`refuses an over-size page unparsed (over ${XSS_LIMITS.htmlLength} characters): nothing fires, the verdict says why`, () => {
    const l = lab((m) => ({ '/big': page(`<img src=x onerror=${m}>`.padEnd(XSS_LIMITS.htmlLength + 1, ' ')) }));
    l.admin.follow('http://citadel.test/big');
    expect(steals(l)).toEqual([]);
    expect(l.admin.verdicts[0].page).toMatchObject({ executes: false, limited: 'size' });
  });

  it(`keeps the last ${SIM_LIMITS.visits} page verdicts, frozen, newest last`, () => {
    const l = lab(() => ({ '/p': page('<p>x</p>') }));
    for (let i = 0; i < SIM_LIMITS.visits + 3; i++) l.admin.follow(`http://citadel.test/p?i=${i}`);
    expect(l.admin.verdicts.map((v) => v.url)).toEqual(Array.from({ length: SIM_LIMITS.visits }, (_, i) => `http://citadel.test/p?i=${i + 3}`));
    expect(Object.isFrozen(l.admin.verdicts) && Object.isFrozen(l.admin.verdicts[0])).toBe(true);
  });

  it('is a SimBrowser: its world, its jar, form posts', () => {
    const l = lab((m) => ({ '/post': (r) => page(r.method === 'POST' ? `<img src=x onerror=${m}>` : '') }));
    expect(l.admin.world).toBe(l.world);
    l.admin.cookies.set('session', 'admin');
    l.admin.submit('http://citadel.test/post', { a: '1' });
    expect(l.seen[0]).toMatchObject({ method: 'POST', cookies: { session: 'admin' } });
    expect(steals(l)).toEqual([STOLEN]);
  });

  it('runs the attacker page\'s navigations too (E1): the page a cross-site link or form lands on is judged, its hash kept', () => {
    const l = lab((m) => ({
      '/post': (r) => page(r.method === 'POST' ? `<img src=x onerror=${m}>` : ''),
      '/hash': page('<p>benign</p>'),
    }), { dom: (p) => (p.path === '/hash' ? { html: decodeURIComponent(p.hash.slice(1)) } : undefined) });
    l.admin.crossSitePost('http://citadel.test/post', { a: '1' });
    expect(l.seen[0]).toMatchObject({ method: 'POST', headers: { origin: 'http://attacker.test', 'sec-fetch-site': 'cross-site' } });
    expect(steals(l)).toEqual([STOLEN]);
    l.admin.crossSiteLink(`http://citadel.test/hash#${encodeURIComponent(`<img src=x onerror=${l.marker.call}>`)}`);
    expect(steals(l)).toEqual([STOLEN, STOLEN]);
    expect(l.admin.verdicts.map((v) => [v.url, v.fired])).toEqual([['http://citadel.test/post', true], ['http://citadel.test/hash', true]]);
  });

  it('a fetch\'s answer is data for a script, never a rendered page: a payload in it never fires, and no verdict is kept (E1)', () => {
    const l = lab((m) => ({ '/api': page(`<img src=x onerror=${m}>`, { 'Access-Control-Allow-Origin': '*' }) }));
    const f = l.admin.corsFetch('http://citadel.test/api');
    expect(f.verdict).toBe('readable');
    expect(l.seen).toHaveLength(1);
    expect(steals(l)).toEqual([]);
    expect(l.admin.verdicts).toEqual([]);
  });

  it('a framed page runs only if the frame shows it: X-Frame-Options or frame-ancestors keep a payload from firing (E1)', () => {
    const l = lab((m) => ({
      '/open': page(`<img src=x onerror=${m}>`),
      '/deny': page(`<img src=x onerror=${m}>`, { 'X-Frame-Options': 'DENY' }),
      '/none': page(`<img src=x onerror=${m}>`, { 'Content-Security-Policy': "frame-ancestors 'none'" }),
      '/form': (r) => page(r.method === 'POST' ? `<svg onload=${m}>` : '<form>'),
    }));
    expect(l.admin.frame('http://citadel.test/deny').framed).toBe(false);
    expect(l.admin.frame('http://citadel.test/none').framed).toBe(false);
    expect(steals(l)).toEqual([]);
    expect(l.admin.frame('http://citadel.test/open').framed).toBe(true);
    expect(steals(l)).toEqual([STOLEN]);
    const f = l.admin.frame('http://citadel.test/form');
    l.admin.clickThrough(f, '/form', { a: '1' }); // the click's answer is shown in the same frame, so it is judged too
    expect(steals(l)).toEqual([STOLEN, STOLEN]);
    expect(l.admin.verdicts.map((v) => v.url)).toEqual(['http://citadel.test/open', 'http://citadel.test/form', 'http://citadel.test/form']);
  });

  it('a sandboxed frame\'s navigation is framed on the attacker\'s page: a page that refuses frames never runs there (E1)', () => {
    const l = lab((m) => ({ '/deny': (r) => page(r.method === 'POST' ? `<svg onload=${m}>` : '', { 'X-Frame-Options': 'DENY' }) }));
    l.admin.crossSitePost('http://citadel.test/deny', {}, { page: { sandboxed: true } });
    expect(steals(l)).toEqual([]);
    l.admin.crossSitePost('http://citadel.test/deny', {}); // the top-level window: no frame to refuse
    expect(steals(l)).toEqual([STOLEN]);
  });

  it('refuses bad options when the lab is built', () => {
    const build = (opts: Partial<XssVictimOptions>) => () => perSession(() => xssBrowser(simWorld(), () => page(''), { marker: markerCall('0123456789abcdef'), canary: 'x', ...opts }))
      .for({ sessionId: `bad-${++n}`, level: 'acolyte' });
    expect(build({ marker: 'alert(1)' })).toThrow(/marker/);
    expect(build({ canary: 42 as never })).toThrow(/canary/);
    expect(build({ dom: 'x' as never })).toThrow(/dom/);
    expect(build({ interact: 'yes' as never })).toThrow(/interact/);
    expect(() => xssBrowser(perSession(() => simWorld()).for({ sessionId: `w-${++n}`, level: 'acolyte' }), () => page(''), { marker: markerCall('0123456789abcdef'), canary: 'x' }))
      .toThrow(/perSession/);
  });
});

describe('xssBrowser dom: client-rendered sinks through a twin of the page\'s own script (DOM XSS, prototype pollution)', () => {
  const pages: XssPage[] = [];
  const twin = (p: XssPage) => {
    pages.push(p);
    // The client script: view.innerHTML = decodeURIComponent(location.hash.slice(1))
    if (p.path === '/view') return { html: decodeURIComponent(p.hash.slice(1)) };
    if (p.path === '/write') return { html: decodeURIComponent(p.hash.slice(1)), insertion: 'document' as const };
    if (p.path === '/prefs') return { html: p.query.get('header') ?? '' };
    return undefined;
  };
  const viewer = (extra: Partial<XssVictimOptions> = {}) => lab(() => ({
    '/view': page('<div id="view"></div><script src="/static/router.js"></script>'), '/write': page('<p>w</p>'), '/prefs': page('<p>p</p>'),
    '/to-view': { status: 302, headers: { Location: '/view' } }, '/to-view-own': { status: 302, headers: { Location: '/view#own' } },
  }), { dom: twin, ...extra });

  it('the twin sees location.hash as the browser has it (the server never does), and the query', () => {
    pages.length = 0;
    const l = viewer();
    l.admin.follow('http://citadel.test/view?x=1#<b>a b</b>');
    expect(l.seen[0].url).toBe('http://citadel.test/view?x=1');
    expect(pages[0]).toMatchObject({ url: 'http://citadel.test/view?x=1', path: '/view', hash: '#%3Cb%3Ea%20b%3C/b%3E', status: 200 });
    expect(pages[0].query.get('x')).toBe('1');
    expect(pages[0].body).toContain('<div id="view">');
    expect(Object.isFrozen(pages[0])).toBe(true);
  });

  it('innerHTML: an inserted script never runs, an inserted handler does', () => {
    const l = viewer();
    l.admin.follow(`http://citadel.test/view#${encodeURIComponent(`<script>${l.marker.call}</script>`)}`);
    expect(steals(l)).toEqual([]);
    expect(l.admin.verdicts[0].dom).toMatchObject({ executes: false, reachedMarker: true });
    l.admin.follow(`http://citadel.test/view#${encodeURIComponent(`<img src=x onerror=${l.marker.call}>`)}`);
    expect(steals(l)).toEqual([STOLEN]);
    expect(l.admin.verdicts[1]).toMatchObject({ fired: true, page: { executes: false }, dom: { executes: true } });
  });

  it('document.write (insertion: document): a written script runs', () => {
    const l = viewer();
    l.admin.follow(`http://citadel.test/write#${encodeURIComponent(`<script>${l.marker.call}</script>`)}`);
    expect(steals(l)).toEqual([STOLEN]);
  });

  it('the query reaches the twin (a pollution gadget reads it); a page the twin ignores is judged on its own', () => {
    const l = viewer();
    l.admin.follow(`http://citadel.test/prefs?header=${encodeURIComponent(`<img src=x onerror=${l.marker.call}>`)}`);
    l.admin.follow('http://citadel.test/elsewhere');
    expect(steals(l)).toEqual([STOLEN]);
    expect(l.admin.verdicts[1].dom).toBeUndefined();
  });

  it('a redirect without a fragment keeps the link\'s (as browsers do); one with its own replaces it', () => {
    pages.length = 0;
    const l = viewer();
    l.admin.follow('http://citadel.test/to-view#kept');
    l.admin.follow('http://citadel.test/to-view-own#lost');
    expect(pages.map((p) => p.hash)).toEqual(['#kept', '#own']);
  });

  it('a twin that throws on hostile input (M1) wrote nothing: the page is still judged, the action does not fail', () => {
    const l = lab((m) => ({ '/view': page(`<img src=x onerror=${m}>`), '/quiet': page('<p>x</p>') }), {
      dom: (p) => ({ html: decodeURIComponent(p.hash.slice(1)) }), // throws URIError on a malformed escape
    });
    expect(() => l.admin.follow('http://citadel.test/quiet#%E0%A4%A')).not.toThrow();
    expect(l.admin.verdicts[0]).toMatchObject({ fired: false, domFailed: true });
    expect(l.admin.verdicts[0].dom).toBeUndefined();
    l.admin.follow('http://citadel.test/view#%E0%A4%A');
    expect(steals(l)).toEqual([STOLEN]); // the server page itself still ran
  });

  it('a twin answer must be { html, insertion? }', () => {
    const l = lab(() => ({ '/view': page('') }), { dom: () => ({ html: 5 }) as never });
    expect(() => l.admin.follow('http://citadel.test/view')).toThrow(/dom/);
  });
});

describe('xssBrowser: the canary is read once the browser has the page\'s cookies (M6)', () => {
  /** A lab whose payload steals the admin's live session cookie. */
  const cookieLab = (routes: (m: string) => Record<string, Route>) => perSession(() => {
    const world = simWorld();
    const marker = newMarker();
    const table = routes(marker.call);
    const admin: XssBrowser = xssBrowser(world, (r) => {
      const route = table[r.path];
      return route === undefined ? { status: 404 } : typeof route === 'function' ? route(r) : route;
    }, { marker: marker.call, canary: () => admin.cookies.get('session') ?? '' });
    admin.cookies.set('session', 'old');
    return { world, admin };
  }).for({ sessionId: `cookie-lab-${++n}`, level: 'acolyte' });
  const stolen = (l: { world: SimWorld }) => l.world.attackerLog.entries().map((h) => h.url);

  it('a page that sets the session and runs the payload steals the new value', () => {
    const l = cookieLab((m) => ({ '/p': page(`<img src=x onerror=${m}>`, { 'Set-Cookie': 'session=fresh; Path=/' }) }));
    l.admin.follow('http://citadel.test/p');
    expect(stolen(l)).toEqual([`${XSS_STEAL_URL}?c=fresh`]);
  });

  it('a page that moves on (Refresh) to a sign-out: the value the page had, as its cookies left it', () => {
    const l = cookieLab((m) => ({
      '/p': page(`<img src=x onerror=${m}>`, { 'Set-Cookie': 'session=fresh; Path=/', Refresh: '0; url=/logout' }),
      '/logout': page('bye', { 'Set-Cookie': 'session=; Max-Age=0; Path=/' }),
    }));
    l.admin.follow('http://citadel.test/p');
    expect(stolen(l)).toEqual([`${XSS_STEAL_URL}?c=fresh`]);
    expect(l.admin.cookies.get('session')).toBeUndefined();
  });

  it('the canary is read before the next page answers (a server-state canary the next page rotates)', () => {
    const l = perSession(() => {
      const world = simWorld();
      const marker = newMarker();
      const state = { token: 'T1' };
      const admin = xssBrowser(world, (r) => {
        if (r.path === '/p') return page(`<img src=x onerror=${marker.call}>`, { Refresh: '0; url=/rotate' });
        if (r.path === '/rotate') { state.token = 'T2'; return page('rotated'); }
        return { status: 404 };
      }, { marker: marker.call, canary: () => state.token });
      return { world, admin };
    }).for({ sessionId: `rotate-${++n}`, level: 'acolyte' });
    l.admin.follow('http://citadel.test/p');
    expect(stolen(l)).toEqual([`${XSS_STEAL_URL}?c=T1`]); // what the payload could read while /p was the page
  });

  it('a form post that fires steals once, after the visit', () => {
    const l = cookieLab((m) => ({ '/f': page(`<svg onload=${m}>`, { 'Set-Cookie': 'session=posted; Path=/' }) }));
    l.admin.submit('http://citadel.test/f', { a: '1' });
    expect(stolen(l)).toEqual([`${XSS_STEAL_URL}?c=posted`]);
  });
});

describe('memory: what xssBrowser keeps is its own copy', () => {
  it(`an XSS browser weighs ${XSS_LIMITS.verdictsWeight / 1024} KiB more than a plain victim browser in the shared byte budget (M4)`, () => {
    const make = (xss: boolean) => () => perSession(() => {
      const world = simWorld();
      const marker = newMarker();
      return xss ? xssBrowser(world, () => page(''), { marker: marker.call, canary: 'c' }) : world.browser(() => page(''));
    }).for({ sessionId: `weigh-${++n}`, level: 'acolyte' });
    const weigh = (f: () => unknown): number => { const before = cappedBudgetUsage().bytes; f(); return cappedBudgetUsage().bytes - before; };
    const plain = weigh(make(false));
    expect(plain).toBe(SIM_LIMITS.inboxWeight + SIM_LIMITS.attackerLogWeight + SIM_LIMITS.visitsWeight + SIM_LIMITS.browserWeight);
    expect(weigh(make(true))).toBe(plain + XSS_LIMITS.verdictsWeight);
  });

  it('its verdicts, filled to every cap with two-byte text, retain less than that weight', () => {
    const gc = fullGc();
    let round = 0;
    /** More sinks than a verdict lists, each detail a long two-byte custom element name, on every page and DOM write. */
    const sinks = (m: string, tag: string) => Array.from({ length: XSS_LIMITS.sinks + 4 }, (_, k) => `<x-${`${tag}${k}`.padEnd(90, '✓')} onclick=${m}>x</x-y>`).join('');
    const url = (i: number, v: number) => `http://citadel.test/${`p${round}-${i}-${v}`.padEnd(SIM_LIMITS.urlLength - 30, 'a')}`;
    const measure = (xss: boolean): number => {
      round++;
      const browsers = Array.from({ length: 16 }, () => perSession(() => {
        const world = simWorld();
        const marker = newMarker();
        const handler = () => page(sinks(marker.call, `p${round}`));
        return xss ? xssBrowser(world, handler, { marker: marker.call, canary: 'c', dom: () => ({ html: sinks(marker.call, `d${round}`) }) }) : world.browser(handler);
      }).for({ sessionId: `fill-${++n}`, level: 'acolyte' }));
      gc(); gc();
      const a = process.memoryUsage();
      browsers.forEach((b, i) => { for (let v = 0; v < SIM_LIMITS.visits; v++) b.follow(url(i, v)); });
      gc(); gc();
      const b = process.memoryUsage();
      return ((b.heapUsed - a.heapUsed) + (b.arrayBuffers - a.arrayBuffers)) / browsers.length;
    };
    measure(true); // warm up: the first round also allocates compiled code
    const verdicts = measure(true) - measure(false);
    // Measured on this box: ~53 KiB; the weight adds ~10%, rounded up to 32 KiB.
    expect(verdicts).toBeLessThan(XSS_LIMITS.verdictsWeight);
    expect(verdicts).toBeGreaterThan(20 * 1024); // the fill really filled them
  });

  it(`keeps at most ${SIM_LIMITS.visits} page verdicts of at most ${XSS_LIMITS.sinks} sinks each (M4)`, () => {
    expect(XSS_LIMITS.sinks).toBeLessThanOrEqual(16);
    expect(XSS_LIMITS.detailLength).toBeLessThanOrEqual(80);
    const many = (m: string) => `${'<iframe srcdoc="&lt;iframe srcdoc=&quot;&lt;svg onload=x&gt;&quot;&gt;&lt;/iframe&gt;"></iframe>'.repeat(30)}<img src=x onerror=${m}>`;
    const l = lab((m) => ({ '/p': page(many(m)) }), { dom: () => ({ html: '<img src=x onerror=x>'.repeat(40) }) });
    for (let i = 0; i < SIM_LIMITS.visits + 2; i++) l.admin.follow(`http://citadel.test/p?i=${i}`);
    const verdicts = l.admin.verdicts.flatMap((v) => [v.page, ...(v.dom === undefined ? [] : [v.dom])]);
    expect(verdicts).toHaveLength(2 * SIM_LIMITS.visits);
    for (const v of verdicts) {
      expect(v.sinks.length).toBeLessThanOrEqual(XSS_LIMITS.sinks);
      for (const s of v.sinks) expect(s.detail.length).toBeLessThanOrEqual(XSS_LIMITS.detailLength);
    }
  });

  it('verdicts do not pin the pages they judged', () => {
    const gc = fullGc();
    const labs = Array.from({ length: 20 }, () => lab((m) => ({
      '/p': (r) => page(`<img src=x onerror=${m} title="${r.query.get('i')}">`.padEnd(XSS_LIMITS.htmlLength - 10, '✓')),
    })));
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    labs.forEach((l, j) => { for (let v = 0; v < SIM_LIMITS.visits; v++) l.admin.follow(`http://citadel.test/p?i=${j}-${v}`); });
    gc(); gc();
    // Pinned page bodies (two-byte text): 20 labs x 5 verdicts x ~32 KB = ~3.2 MB. As copies: well under 1.5 MB in all (the
    // visits keep their own 2000-char clips of each body, as the sim always does).
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1.5 * 1024 * 1024);
    expect(labs.every((l) => l.admin.verdicts.length === SIM_LIMITS.visits && steals(l).length === SIM_LIMITS.visits)).toBe(true);
  });
});
