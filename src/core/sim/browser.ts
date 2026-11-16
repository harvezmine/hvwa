// src/core/sim/browser.ts — the victim's browser: a cookie jar plus a request loop whose citadel.test requests are
// answered IN PROCESS by the lab's handler and whose attacker.test requests land in the player's log. Every other host
// is unreachable; nothing here opens a socket, resolves a name or fetches. Besides the victim's own navigations
// (follow, submit) it runs what the player's attacker page makes the victim's browser do (crossSiteLink,
// crossSitePost): requests that cross sites, shaped by the rules in cross.ts and the SameSite jar in cookies.ts.
import { SIM_LIMITS, clip, str } from './limits.js';
import { Jar, parseCookieHeader, type SimCookieContext, type SimCookieJar } from './cookies.js';
import {
  bodyFields, encodeForm, fetchSiteOf, formEnctype, formEntries, initiatorOf, originHeader, parsePolicy, redirectTainted,
  refererFor, type ReferrerPolicy, type SimFormFields, type SimInitiator,
} from './cross.js';
import { ATTACKER_ORIGIN, classifySimUrl, type SimSite, type SimUnreachable, type SimUrl } from './url.js';
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
  /**
   * Lower-case names: host, user-agent, and when present referer, cookie, content-type and origin (every POST, every
   * cross-origin fetch). A request the attacker's page started, or one made in a frame, also carries sec-fetch-site,
   * sec-fetch-mode and sec-fetch-dest. The victim's own navigations (follow, submit) carry no sec-fetch-* headers.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Cookies sent with the request (decoded; null prototype). */
  readonly cookies: Readonly<Record<string, string>>;
  /**
   * The body's form fields (null prototype), as the app's own parsers read them: an urlencoded body's fields, or a
   * JSON object's string members; {} for any other body (text/plain, multipart) and for a GET. Works with field().
   */
  readonly body: Readonly<Record<string, string>>;
  /** The body exactly as sent ('' for a GET): read a text/plain or JSON body from here. */
  readonly rawBody: string;
}

/** What the citadel handler answers. Header names are case-insensitive. */
export interface SimResponse {
  readonly status: number;
  /**
   * `Location` (followed on 301, 302, 303, 307 and 308 only; a Location or Refresh value with CR or LF is a malformed response: the visit is unreachable), `Set-Cookie` (one line or a list), `Refresh` ("0; url=..": the page moves the
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

/** The player's attacker page, as the lab declares it (never parsed from HTML, never run): where it is, its policy. */
export interface SimAttackerPage {
  /** Its URL, on attacker.test or any *.attacker.test (default ATTACKER_PAGE_URL). Origin and Referer come from it. */
  readonly url?: string;
  /**
   * Its referrer policy (a `<meta name="referrer">`, `rel=noreferrer`, or its server's header): one token or a list,
   * the last known one wins. Default 'strict-origin-when-cross-origin', Chrome's default.
   */
  readonly referrerPolicy?: string;
  /**
   * The request comes from a sandboxed iframe inside the page (`<iframe sandbox="allow-scripts allow-forms">`, or a
   * `data:` document): an opaque origin, so `Origin: null`. Its form or link navigates that frame, not the top-level
   * page (so a Lax cookie is not sent even on a GET).
   */
  readonly sandboxed?: boolean;
}

/** Where the attacker page is when the lab names none. */
export const ATTACKER_PAGE_URL = `${ATTACKER_ORIGIN}/`;

/** What every cross-site primitive takes: the attacker page it runs on. */
export interface SimCrossSiteOptions {
  readonly page?: SimAttackerPage;
}

export interface SimCrossSitePostOptions extends SimCrossSiteOptions {
  /**
   * The form's enctype: 'application/x-www-form-urlencoded' (the default, and what a browser uses for any value it
   * does not know), 'multipart/form-data' or 'text/plain' (fields sent as `name=value` lines, unescaped).
   */
  readonly contentType?: string;
}

/** A victim's browser: a cookie jar plus a request loop. */
export interface SimBrowser {
  /** The world it lives in (its inbox, its attacker log). */
  readonly world: SimWorld;
  readonly cookies: SimCookieJar;
  /** Open a link (GET), from a mail client (no Referer) or clicked on a citadel page (`referrer`). Same-site. */
  follow(url: string, opts?: SimNavigateOptions): SimVisit;
  /** Submit a form (POST, urlencoded), on a citadel page. Same-site; it carries `Origin: http://citadel.test`. */
  submit(url: string, form: Readonly<Record<string, string>>, opts?: SimNavigateOptions): SimVisit;
  /**
   * The victim clicks a link on the attacker's page (or the page sets `location`): a top-level GET navigation that
   * crosses sites. SameSite=Lax and None cookies are sent, Strict ones are not; no Origin; Sec-Fetch-Site cross-site.
   */
  crossSiteLink(url: string, opts?: SimCrossSiteOptions): SimVisit;
  /**
   * The attacker's page auto-submits a hidden form to `url` (CSRF): a top-level POST navigation that crosses sites,
   * encoded as the form's enctype (`contentType`). Only SameSite=None cookies are sent; `Origin` is the page's
   * (`null` when its referrer policy hides it, or from a sandboxed frame); Sec-Fetch-Site cross-site. The citadel's
   * answer renders as a page, as for any navigation.
   */
  crossSitePost(url: string, form: SimFormFields, opts?: SimCrossSitePostOptions): SimVisit;
}

/** Fetch's redirect statuses: the only ones whose Location a browser follows. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The legacy browser default (before 2020): the full URL, except https -> http. Pages tighten it with Referrer-Policy. */
const DEFAULT_POLICY: ReferrerPolicy = 'no-referrer-when-downgrade';
/** Chrome's default since 2020, for the attacker's page when the lab names no policy. */
const ATTACKER_DEFAULT_POLICY: ReferrerPolicy = 'strict-origin-when-cross-origin';

/** CR or LF: never part of a real header value. */
const CRLF_RE = /[\r\n]/;

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
export function headerMap(res: SimResponse): Map<string, string[]> {
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

/** A fresh null-prototype copy of a request's fields (each hop gets its own, frozen). */
function copyFields(fields: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = v;
  return out;
}

/** A request body as sent: its Content-Type, the bytes as text, and the fields the lab reads (SimRequest.body). */
interface Payload { readonly type: string; readonly raw: string; readonly fields: Record<string, string> }

/** The attacker page as the browser uses it: where it is, its initiator (origin, site) and referrer policy. */
interface Page { readonly url: SimUrl; readonly init: SimInitiator; readonly policy: ReferrerPolicy; readonly sandboxed: boolean }

/**
 * Who makes a request and how (Fetch's initiator, mode and destination), fixed for one visit except where a page that
 * moves on by itself becomes the next request's initiator.
 */
interface Context {
  /** The document that made the request; undefined for the victim's own navigations (follow, submit). */
  init?: SimInitiator;
  /** The cookie context (cookies.ts): same-site for cookies, and whether the top-level page navigates. */
  site: 'same' | 'cross';
  readonly topLevel: boolean;
  readonly dest: 'document' | 'iframe' | 'empty';
  /** Add sec-fetch-* (requests the attacker's page starts, and anything in a frame). */
  readonly shaped: boolean;
}

/** Where a visit starts. */
interface Start {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Payload;
  /** The page the request is made from (its Referer source) and its referrer policy. */
  readonly referrer?: SimUrl;
  readonly policy: ReferrerPolicy;
  /** The initiator of a POST from the victim's own navigation (submit): its Origin. */
  readonly origin?: SimInitiator;
}

export class Browser implements SimBrowser {
  private readonly jar: Jar;

  constructor(readonly world: World, private readonly handler: SimHandler) {
    this.jar = new Jar(() => world.now());
  }

  get cookies(): SimCookieJar { return this.jar; }

  follow(url: string, opts: SimNavigateOptions = {}): SimVisit {
    const referrer = citadelReferrer(opts);
    return this.navigate({ method: 'GET', url, policy: DEFAULT_POLICY, ...(referrer ? { referrer } : {}) }, ownNavigation());
  }

  submit(url: string, form: Readonly<Record<string, string>>, opts: SimNavigateOptions = {}): SimVisit {
    const referrer = citadelReferrer(opts);
    const fields = formOf(form);
    // The form is on a citadel page: the referrer when given, else the page it posts to.
    const origin = initiatorOf(referrer ?? classifySimUrl(url));
    const payload: Payload = { type: 'application/x-www-form-urlencoded', raw: new URLSearchParams(Object.entries(fields)).toString(), fields };
    return this.navigate({ method: 'POST', url, payload, policy: DEFAULT_POLICY, origin, ...(referrer ? { referrer } : {}) }, ownNavigation());
  }

  crossSiteLink(url: string, opts: SimCrossSiteOptions = {}): SimVisit {
    const page = attackerPage(opts.page);
    return this.navigate({ method: 'GET', url, referrer: page.url, policy: page.policy }, fromPage(page));
  }

  crossSitePost(url: string, form: SimFormFields, opts: SimCrossSitePostOptions = {}): SimVisit {
    const page = attackerPage(opts.page);
    const { type, raw } = encodeForm(formEntries(form), formEnctype(opts.contentType));
    return this.navigate({ method: 'POST', url, payload: { type, raw, fields: bodyFields(type, raw) }, referrer: page.url, policy: page.policy }, fromPage(page));
  }

  /**
   * The request loop shared by every navigation: citadel requests go to the handler, attacker.test requests to the
   * log (the visit ends there), anything else is unreachable. Redirects (Location on a redirect status) and pages that
   * move on by themselves (Refresh) are followed, at most SIM_LIMITS.maxRedirects; the same request again with the jar
   * unchanged is a loop.
   */
  private navigate(start: Start, ctx: Context): SimVisit {
    let { method, referrer, policy } = start;
    let payload = start.payload;
    let raw = str(start.url);
    let target = classifySimUrl(start.url);
    let via: SimHop['via'] = 'start';
    let redirects = 0;
    /** The URLs requested since the current initiator made the request (Fetch's URL list). */
    let urls: SimUrl[] = [];
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
      const key = `${method} ${target.url}\n${payload?.raw ?? ''}\n${this.jar.version}`;
      if (seen.has(key)) return finish('loop');
      seen.add(key);
      urls = [...urls, target];
      const sent = referrer === undefined ? undefined : refererFor(referrer, target, policy);
      const referer = sent === undefined ? undefined : clip(sent, SIM_LIMITS.urlLength); // kept in the hop: a copy
      const withReferer: { referer?: string } = referer === undefined ? {} : { referer };
      if (target.site === 'attacker') {
        // The player's server: the request is logged and the visit ends (nothing is served back).
        hop({ site: 'attacker', method, url: target.url, via, ...withReferer });
        this.world.attackerLog.record({
          method, url: target.url, ...withReferer, ...(method === 'POST' && payload !== undefined ? { body: payload.raw } : {}),
        });
        return finish('attacker');
      }
      const cookieCtx: SimCookieContext = { site: ctx.site, method, topLevel: ctx.topLevel };
      const cookie = this.jar.headerFor(target, cookieCtx);
      const headers: Record<string, string> = { host: target.host, 'user-agent': SIM_USER_AGENT, ...withReferer };
      if (cookie !== '') headers.cookie = cookie;
      if (method === 'POST' && payload !== undefined) headers['content-type'] = payload.type;
      const init = ctx.init ?? start.origin;
      if (init !== undefined) {
        const origin = originHeader({ init, method, cors: false, target, policy, tainted: redirectTainted(init, urls) });
        if (origin !== undefined) headers.origin = clip(origin, SIM_LIMITS.urlLength);
      }
      if (ctx.shaped && ctx.init !== undefined) {
        headers['sec-fetch-site'] = fetchSiteOf(ctx.init, urls);
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-dest'] = ctx.dest;
      }
      const req: SimRequest = Object.freeze({
        method, url: target.url, path: target.path, query: new URLSearchParams(target.search),
        headers: Object.freeze(headers), cookies: Object.freeze(parseCookieHeader(cookie)),
        body: Object.freeze(copyFields(payload?.fields)), rawBody: payload?.raw ?? '',
      });
      const res = checkResponse(this.handler(req));
      const h = headerMap(res);
      for (const line of h.get('set-cookie') ?? []) this.jar.store(line, target, cookieCtx);
      hop({ site: 'citadel', method, url: target.url, via, ...withReferer, status: res.status });
      // A Location or Refresh value with CR or LF cannot exist in real HTTP (Node refuses to send it, a browser
      // never receives it), and WHATWG URL parsing would silently drop the characters here. So the response is
      // malformed and the visit unreachable: a lab must not pass in the sim what a real browser could not do.
      const badHeader = CRLF_RE.test(h.get('location')?.[0] ?? '') ? 'redirect' : CRLF_RE.test(h.get('refresh')?.[0] ?? '') ? 'refresh' : undefined;
      if (badHeader !== undefined) {
        hop({ site: 'other', method, url: '', via: badHeader, reason: 'invalid' });
        return finish('unreachable');
      }
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
          payload = undefined;
        }
        raw = location;
        target = classifySimUrl(location, target.url);
        via = 'redirect';
      } else {
        // A page that moves on by itself: the page is the new referrer, under its own Referrer-Policy, and the
        // initiator of the next request. A citadel page in the top-level window makes that request same-site; a framed
        // one does not (the top-level page is still the attacker's).
        referrer = target;
        policy = parsePolicy(h.get('referrer-policy')) ?? DEFAULT_POLICY;
        if (ctx.init !== undefined) ctx.init = initiatorOf(target);
        if (ctx.topLevel) ctx.site = 'same';
        urls = [];
        method = 'GET';
        payload = undefined;
        raw = refresh as string;
        target = classifySimUrl(raw, target.url);
        via = 'refresh';
      }
    }
  }
}

/** follow()'s and submit()'s `referrer`, checked: a citadel page. */
function citadelReferrer(opts: SimNavigateOptions): SimUrl | undefined {
  if (opts.referrer === undefined) return undefined;
  const referrer = classifySimUrl(opts.referrer);
  if (referrer.site !== 'citadel') throw new Error('SimBrowser: a referrer must be a citadel.test page');
  return referrer;
}

/** The victim's own navigation (a link from mail, a click or a form on a citadel page): same-site, top-level, as before E1. */
function ownNavigation(): Context {
  return { site: 'same', topLevel: true, dest: 'document', shaped: false };
}

/** The attacker page a lab declared, checked: on attacker.test, with a known (or the default) referrer policy. */
function attackerPage(p: SimAttackerPage | undefined): Page {
  if (p !== undefined && (p === null || typeof p !== 'object')) throw new Error('SimBrowser: page must be { url?, referrerPolicy?, sandboxed? }');
  const url = classifySimUrl(p?.url ?? ATTACKER_PAGE_URL);
  if (url.site !== 'attacker') throw new Error('SimBrowser: the attacker page must be on attacker.test (or a subdomain of it)');
  if (p?.referrerPolicy !== undefined && typeof p.referrerPolicy !== 'string') throw new Error('SimBrowser: page.referrerPolicy must be a string');
  const sandboxed = p?.sandboxed === true;
  return { url, init: initiatorOf(url, sandboxed), policy: parsePolicy(p?.referrerPolicy === undefined ? undefined : [p.referrerPolicy]) ?? ATTACKER_DEFAULT_POLICY, sandboxed };
}

/** A navigation the attacker's page starts: cross-site, in the top-level window unless it runs in a sandboxed frame. */
function fromPage(page: Page): Context {
  return { init: page.init, site: 'cross', topLevel: !page.sandboxed, dest: page.sandboxed ? 'iframe' : 'document', shaped: true };
}
