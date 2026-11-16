// The XSS sink interpreter (core/victim.ts xssBrowser): the simulated admin "views" a citadel page, the static oracle
// decides whether the page's script would have run the player's marker, and if so the admin's stolen canary lands in
// the player's attacker log. In process; no HTTP (the fixture lab in tests/xss-lab.spec.ts drives the real app).
import { describe, expect, it } from 'vitest';
import { perSession } from '../src/core/lab.js';
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

  it('a twin answer must be { html, insertion? }', () => {
    const l = lab(() => ({ '/view': page('') }), { dom: () => ({ html: 5 }) as never });
    expect(() => l.admin.follow('http://citadel.test/view')).toThrow(/dom/);
  });
});

describe('memory: what xssBrowser keeps is its own copy', () => {
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
