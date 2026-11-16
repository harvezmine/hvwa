// src/core/sim/browser.ts — the victim's browser: a cookie jar plus a navigation loop whose citadel.test requests
// are answered IN PROCESS by the lab's handler and whose attacker.test requests land in the player's log. Every other
// host is unreachable; nothing here opens a socket, resolves a name or fetches.
import { SIM_LIMITS, clip, str } from './limits.js';
import { Jar, parseCookieHeader, type SimCookieJar } from './cookies.js';
import { classifySimUrl, type SimSite, type SimUnreachable, type SimUrl } from './url.js';
import type { SimWorld, World } from './world.js'; // type only: the world imports this module at runtime

/** The User-Agent the victim's browser sends to the citadel. */
export const SIM_USER_AGENT = 'CitadelBrowser/1.0 (simulated victim)';

export function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (typeof x === 'object' || typeof x === 'function') && x !== null
    && typeof (x as { then?: unknown }).then === 'function';
}

/** What the lab's citadel handler receives: a plain object built by the browser, never an Express request. */
export interface SimRequest {
  readonly method: 'GET' | 'POST';
  /** The absolute URL (no userinfo, no fragment). */
  readonly url: string;
  /** Path on citadel.test ('/callback'): the lab route <labPath>/callback. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Lower-case names: host, user-agent, and when present referer, cookie, content-type. */
  readonly headers: Readonly<Record<string, string>>;
  /** Cookies sent with the request (decoded; null prototype). */
  readonly cookies: Readonly<Record<string, string>>;
  /** POST form fields (null prototype); {} for a GET. Works with field(). */
  readonly body: Readonly<Record<string, string>>;
}

/** What the citadel handler answers. Header names are case-insensitive. */
export interface SimResponse {
  readonly status: number;
  /**
   * `Location` (followed on 301, 302, 303, 307 and 308 only), `Set-Cookie` (one line or a list), `Refresh` ("0; url=..": the page moves the
   * browser on, sending ITS URL as Referer: the stand-in for a meta refresh or script navigation) and
   * `Referrer-Policy` (what the next hop's Referer may contain). Others are ignored.
   */
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: string;
}

/** The lab's citadel.test: built from its own level functions, synchronous, never real HTTP. */
export type SimHandler = (req: SimRequest) => SimResponse;

export type SimOutcome = 'page' | 'attacker' | 'unreachable' | 'too-many-redirects' | 'loop';

/** One request in a visit. Frozen. */
export interface SimHop {
  readonly site: SimSite;
  readonly method: 'GET' | 'POST';
  /** The URL requested (for an unreachable hop: the URL that could not be reached, clipped). */
  readonly url: string;
  /** How the browser got here: the link itself, a redirect's Location, or a page's Refresh. */
  readonly via: 'start' | 'redirect' | 'refresh';
  readonly referer?: string;
  /** The citadel's status (citadel hops only). */
  readonly status?: number;
  /** Why an `other` hop is unreachable. */
  readonly reason?: SimUnreachable;
}

/** The trace of one navigation (for tests and the panel). Frozen. */
export interface SimVisit {
  /**
   * page: ended on a citadel page (see `page`); attacker: reached attacker.test (logged, nothing comes back);
   * unreachable: an `other` URL; too-many-redirects: more than SIM_LIMITS.maxRedirects; loop: the same request
   * again with the jar unchanged.
   */
  readonly outcome: SimOutcome;
  readonly hops: readonly SimHop[];
  /** The citadel page the visit ended on (outcome 'page'); its body clipped to SIM_LIMITS.bodyLength. */
  readonly page?: { readonly url: string; readonly status: number; readonly body: string };
}

export interface SimNavigateOptions {
  /**
   * The citadel page the victim clicked the link on: it is the Referer of the first request, and stays the
   * Referer across redirects. Default: none (the link was opened from a mail client). Must be a citadel URL.
   */
  readonly referrer?: string;
}

/** A victim's browser: a cookie jar plus a navigation loop. */
export interface SimBrowser {
  /** The world it lives in (its inbox, its attacker log). */
  readonly world: SimWorld;
  readonly cookies: SimCookieJar;
  /** Open a link (GET). */
  follow(url: string, opts?: SimNavigateOptions): SimVisit;
  /** Submit a form (POST, urlencoded). */
  submit(url: string, form: Readonly<Record<string, string>>, opts?: SimNavigateOptions): SimVisit;
}

/** Fetch's redirect statuses: the only ones whose Location a browser follows. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

type ReferrerPolicy = 'no-referrer' | 'no-referrer-when-downgrade' | 'same-origin' | 'origin' | 'strict-origin'
  | 'origin-when-cross-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';
const POLICIES: ReadonlySet<string> = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin',
  'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
]);
/** The legacy browser default (before 2020): the full URL, except https -> http. Pages tighten it with Referrer-Policy. */
const DEFAULT_POLICY: ReferrerPolicy = 'no-referrer-when-downgrade';

/** A Referrer-Policy header value: the last recognized token, or undefined (unknown tokens are ignored). */
function parsePolicy(values: readonly string[] | undefined): ReferrerPolicy | undefined {
  let found: ReferrerPolicy | undefined;
  for (const token of (values ?? []).join(',').split(',')) {
    const p = token.trim().toLowerCase();
    if (POLICIES.has(p)) found = p as ReferrerPolicy;
  }
  return found;
}

/** The Referer a request from page `from` to `to` carries under `policy` (Referrer Policy spec, without length limits). */
function refererFor(from: SimUrl, to: SimUrl, policy: ReferrerPolicy): string | undefined {
  const full = from.url;
  const origin = `${from.origin}/`;
  const sameOrigin = from.origin === to.origin;
  const downgrade = from.url.startsWith('https:') && to.url.startsWith('http:');
  switch (policy) {
    case 'no-referrer': return undefined;
    case 'no-referrer-when-downgrade': return downgrade ? undefined : full;
    case 'same-origin': return sameOrigin ? full : undefined;
    case 'origin': return origin;
    case 'strict-origin': return downgrade ? undefined : origin;
    case 'origin-when-cross-origin': return sameOrigin ? full : origin;
    case 'strict-origin-when-cross-origin': return sameOrigin ? full : downgrade ? undefined : origin;
    case 'unsafe-url': return full;
  }
}

/** The URL of a Refresh header ("<delay>; url=<url>", ";" or ",", url= optional, quotes optional), else undefined. */
function refreshTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*\d+(?:\.[\d.]*)?\s*[;,]\s*(?:url\s*=\s*)?(.*)$/is.exec(value);
  if (!m) return undefined;
  let url = m[1].trim();
  const q = url[0];
  if (q === '"' || q === "'") {
    url = url.slice(1);
    const end = url.indexOf(q);
    if (end !== -1) url = url.slice(0, end);
  }
  return url === '' ? undefined : url;
}

/** A handler's response, checked: synchronous, a valid status, a string body. */
function checkResponse(res: unknown): SimResponse {
  if (isThenable(res)) {
    res.then(undefined, () => {}); // never leave its rejection unhandled
    throw new Error('SimHandler must answer synchronously (it returned a Promise)');
  }
  if (res === null || typeof res !== 'object') throw new Error('SimHandler must return { status, headers?, body? }');
  const { status, headers, body } = res as SimResponse;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`SimHandler: bad status ${String(status)}`);
  if (headers !== undefined && (headers === null || typeof headers !== 'object')) throw new Error('SimHandler: headers must be an object');
  if (body !== undefined && typeof body !== 'string') throw new Error('SimHandler: body must be a string');
  return res as SimResponse;
}

/** Response headers by lower-case name; a value or a list of values each. */
function headerMap(res: SimResponse): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    if (list.length > 0) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) ?? []), ...list]);
  }
  return m;
}

/** A form's own string fields, null prototype. */
function formOf(form: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (form === null || typeof form !== 'object') return out;
  for (const [k, v] of Object.entries(form)) if (typeof v === 'string') out[k] = v;
  return out;
}

const encodeForm = (form: Readonly<Record<string, string>>): string => new URLSearchParams(Object.entries(form)).toString();

export class Browser implements SimBrowser {
  private readonly jar: Jar;

  constructor(readonly world: World, private readonly handler: SimHandler) {
    this.jar = new Jar(() => world.now());
  }

  get cookies(): SimCookieJar { return this.jar; }

  follow(url: string, opts: SimNavigateOptions = {}): SimVisit {
    return this.navigate('GET', url, undefined, opts);
  }

  submit(url: string, form: Readonly<Record<string, string>>, opts: SimNavigateOptions = {}): SimVisit {
    return this.navigate('POST', url, formOf(form), opts);
  }

  private navigate(
    startMethod: 'GET' | 'POST', input: string, startBody: Record<string, string> | undefined, opts: SimNavigateOptions,
  ): SimVisit {
    let referrer: SimUrl | undefined;
    if (opts.referrer !== undefined) {
      referrer = classifySimUrl(opts.referrer);
      if (referrer.site !== 'citadel') throw new Error('SimBrowser: a referrer must be a citadel.test page');
    }
    let policy: ReferrerPolicy = DEFAULT_POLICY;
    let method = startMethod;
    let body = startBody;
    let raw = str(input);
    let target = classifySimUrl(input);
    let via: SimHop['via'] = 'start';
    let redirects = 0;
    const hops: SimHop[] = [];
    const seen = new Set<string>();
    const finish = (outcome: SimOutcome, page?: SimVisit['page']): SimVisit => {
      const visit: SimVisit = Object.freeze({ outcome, hops: Object.freeze(hops), ...(page ? { page: Object.freeze(page) } : {}) });
      this.world.recordVisit(visit);
      return visit;
    };
    const hop = (h: SimHop): void => { hops.push(Object.freeze(h)); };
    for (;;) {
      if (target.site === 'other') {
        hop({ site: 'other', method, url: target.url || clip(raw, SIM_LIMITS.urlLength), via, ...(target.reason ? { reason: target.reason } : {}) });
        return finish('unreachable');
      }
      const encoded = body === undefined ? undefined : encodeForm(body);
      const key = `${method} ${target.url}\n${encoded ?? ''}\n${this.jar.version}`;
      if (seen.has(key)) return finish('loop');
      seen.add(key);
      const sent = referrer === undefined ? undefined : refererFor(referrer, target, policy);
      const referer = sent === undefined ? undefined : clip(sent, SIM_LIMITS.urlLength); // kept in the hop: a copy
      const withReferer: { referer?: string } = referer === undefined ? {} : { referer };
      if (target.site === 'attacker') {
        // The player's server: the request is logged and the visit ends (nothing is served back).
        hop({ site: 'attacker', method, url: target.url, via, ...withReferer });
        this.world.attackerLog.record({
          method, url: target.url, ...withReferer, ...(method === 'POST' && encoded !== undefined ? { body: encoded } : {}),
        });
        return finish('attacker');
      }
      const cookie = this.jar.headerFor(target);
      const headers: Record<string, string> = { host: target.host, 'user-agent': SIM_USER_AGENT, ...withReferer };
      if (cookie !== '') headers.cookie = cookie;
      if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
      const req: SimRequest = Object.freeze({
        method, url: target.url, path: target.path, query: new URLSearchParams(target.search),
        headers: Object.freeze(headers), cookies: Object.freeze(parseCookieHeader(cookie)),
        body: Object.freeze(formOf(body ?? {})),
      });
      const res = checkResponse(this.handler(req));
      const h = headerMap(res);
      for (const line of h.get('set-cookie') ?? []) this.jar.store(line, target);
      hop({ site: 'citadel', method, url: target.url, via, ...withReferer, status: res.status });
      // Only Fetch's redirect statuses follow Location. Any other response (a 300 or 304 with a Location, a 302
      // without one) is a page, so its Refresh, if any, moves the browser on as for any page.
      const location = REDIRECT_STATUSES.has(res.status) ? h.get('location')?.[0] : undefined;
      const refresh = location === undefined ? refreshTarget(h.get('refresh')?.[0]) : undefined;
      if (location === undefined && refresh === undefined) {
        return finish('page', { url: target.url, status: res.status, body: clip(res.body ?? '', SIM_LIMITS.bodyLength) });
      }
      if (redirects >= SIM_LIMITS.maxRedirects) return finish('too-many-redirects');
      redirects++;
      if (location !== undefined) {
        // A redirect is not a page: the referrer stays the page that started the navigation; a Referrer-Policy
        // on the redirect response applies from here on (Fetch). 301/302 turn a POST into a GET, 303 always does.
        policy = parsePolicy(h.get('referrer-policy')) ?? policy;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        raw = location;
        target = classifySimUrl(location, target.url);
        via = 'redirect';
      } else {
        // A page that moves on by itself: the page is the new referrer, under its own Referrer-Policy.
        referrer = target;
        policy = parsePolicy(h.get('referrer-policy')) ?? DEFAULT_POLICY;
        method = 'GET';
        body = undefined;
        raw = refresh as string;
        target = classifySimUrl(raw, target.url);
        via = 'refresh';
      }
    }
  }
}
