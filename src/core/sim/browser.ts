// src/core/sim/browser.ts — the victim's browser: a cookie jar plus a request loop whose citadel.test requests are
// answered IN PROCESS by the lab's handler and whose attacker.test requests land in the player's log. Every other host
// is unreachable; nothing here opens a socket, resolves a name or fetches. Besides the victim's own navigations
// (follow, submit) it runs what the player's attacker page makes the victim's browser do (crossSiteLink,
// crossSitePost): requests that cross sites, shaped by the rules in cross.ts and the SameSite jar in cookies.ts.
import { SIM_LIMITS, clip, str } from './limits.js';
import { Jar, parseCookieHeader, type SimCookieContext, type SimCookieJar } from './cookies.js';
import {
  bodyFields, corsCheck, encodeForm, fetchHeaders, fetchSiteOf, formEnctype, formEntries, framingOf, initiatorOf, needsPreflight,
  originHeader, parsePolicy, redirectTainted, refererFor, type ReferrerPolicy, type SimCorsRead, type SimFormFields, type SimFraming,
  type SimInitiator,
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
   * cross-origin fetch), and sec-fetch-site, sec-fetch-mode and sec-fetch-dest, as Chrome sends them: `none` for a
   * link opened from mail, `same-origin` from a citadel page, `cross-site` from the attacker's page. sec-fetch-user is
   * `?1` on what the victim's own action started (follow, submit, a click through a frame).
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
   * `data:` document): an opaque origin, so `Origin: null` and no Referer at all, whatever the policy (an opaque origin
   * has no referrer). Its form or link navigates that frame, not the top-level page (so a Lax cookie is not sent even on
   * a GET).
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

/** What the attacker page's `fetch(url, init)` call asks for. Its mode is always 'cors' (fetch's default). */
export interface SimFetchOptions extends SimCrossSiteOptions {
  /** Default 'GET'. */
  readonly method?: 'GET' | 'POST';
  /** Default 'same-origin' (fetch's): no cookies to another origin. 'include' sends the victim's cookies SameSite lets through. */
  readonly credentials?: 'omit' | 'same-origin' | 'include';
  /** The headers the page sets. Forbidden ones (Cookie, Origin, Referer, Sec-*, ...) are dropped, as fetch() drops them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A POST's body (a string: a JSON text, a form...). Without a Content-Type header it is sent as text/plain;charset=UTF-8. */
  readonly body?: string;
}

/**
 * The outcome of the attacker page's fetch(): sent or not, and whether the page may read the answer.
 * - 'readable': the CORS check passed; `body` is what the page read.
 * - 'no-allow-origin', 'origin-mismatch', 'wildcard-credentials', 'no-allow-credentials': the request was sent (and did
 *   whatever it does on the citadel), but the browser kept the answer from the page (corsCheck).
 * - 'preflight': not sent. It needs a CORS preflight (a header or method a simple request cannot have), and the sim
 *   approves none: no lab answers OPTIONS.
 * - 'invalid': not sent. fetch() itself throws (a GET with a body, a header name or value it cannot carry).
 * - 'no-answer': sent, but no citadel answer came back to read (it reached your own server, an unreachable host,
 *   too many redirects).
 */
export type SimFetchVerdict = SimCorsRead | 'preflight' | 'invalid' | 'no-answer';

/** What corsFetch() did. Frozen. */
export interface SimFetch {
  /** Whether the browser sent the request ('preflight' and 'invalid' are not sent). */
  readonly sent: boolean;
  readonly verdict: SimFetchVerdict;
  /** The requests it made, when sent. */
  readonly visit?: SimVisit;
  /** The status of the citadel answer the visit ended on, if one did. */
  readonly status?: number;
  /** Only when 'readable': the answer's body as the page read it, clipped to SIM_LIMITS.bodyLength. */
  readonly body?: string;
}

/** frame()'s options: the attacker page that holds the `<iframe>` (not a sandboxed one: not modelled). */
export interface SimFrameOptions {
  readonly page?: Omit<SimAttackerPage, 'sandboxed'>;
}

/** A citadel page the attacker's page put in an `<iframe>` (frame()). Frozen; pass it to clickThrough(). */
export interface SimFrame {
  /** Whether the citadel page is shown in the frame. */
  readonly framed: boolean;
  /**
   * 'allowed'; or why it is not shown: the page refused to be framed ('x-frame-options', 'frame-ancestors': the
   * request was still sent), or no citadel page came back ('not-loaded': attacker.test, unreachable, a loop).
   */
  readonly reason: SimFraming | 'not-loaded';
  readonly visit: SimVisit;
  /** The origin of the attacker page around the frame (its one ancestor). */
  readonly ancestor: string;
  /** The citadel page shown in the frame (visit.page), when framed. */
  readonly page?: SimVisit['page'];
}

/** clickThrough()'s options: the framed form's enctype (as crossSitePost's contentType; default urlencoded). */
export interface SimClickOptions {
  readonly contentType?: string;
}

/** What clickThrough() did. Frozen. */
export interface SimClick {
  /** false when the frame shows no citadel page: the click landed on your decoy alone, and nothing was sent. */
  readonly clicked: boolean;
  /** The form's request and what followed, when clicked. */
  readonly visit?: SimVisit;
}

/** A victim's browser: a cookie jar plus a request loop. */
export interface SimBrowser {
  /** The world it lives in (its inbox, its attacker log). */
  readonly world: SimWorld;
  readonly cookies: SimCookieJar;
  /**
   * Open a link (GET), from a mail client (no Referer; Sec-Fetch-Site none) or clicked on a citadel page (`referrer`;
   * same-origin). Same-site; Sec-Fetch-User ?1 (the victim's own action).
   */
  follow(url: string, opts?: SimNavigateOptions): SimVisit;
  /**
   * Submit a form (POST, urlencoded), on a citadel page. Same-site; it carries `Origin: http://citadel.test`,
   * Sec-Fetch-Site same-origin and Sec-Fetch-User ?1.
   */
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
  /**
   * The attacker's page calls `fetch(url, { method, credentials, headers, body })`: a CORS request (not a navigation,
   * never rendered). With credentials: 'include' only SameSite=None cookies go (a cross-site subresource); Origin is
   * always the page's ('null' from a sandboxed frame); a request that would need a preflight is not sent. The browser
   * then lets the page read the answer only if the citadel's Access-Control-Allow-Origin / -Credentials allow it
   * (corsCheck, on every answer, redirects included).
   */
  corsFetch(url: string, opts?: SimFetchOptions): SimFetch;
  /**
   * The attacker's page holds `<iframe src=url>`: a navigation of a frame (GET), cross-site for cookies (only
   * SameSite=None ones go: the top-level page is the attacker's), Sec-Fetch-Dest iframe. Each page the frame would
   * show is checked against X-Frame-Options and CSP frame-ancestors (framingOf); `framed` says whether it is shown.
   */
  frame(url: string, opts?: SimFrameOptions): SimFrame;
  /**
   * The victim clicks your decoy, which lies over a button of the framed page: that page's form (`action`, resolved
   * against the framed page, and its `form` fields: the lab says what the framed page's form holds) is submitted
   * inside the frame. A POST from the citadel page itself (Origin http://citadel.test, Sec-Fetch-Site same-origin,
   * the framed page as Referer under its own Referrer-Policy), yet still cross-site for cookies: only SameSite=None
   * ones go. Nothing is sent when the frame shows no citadel page. Throws for a frame this browser did not load.
   */
  clickThrough(frame: SimFrame, action: string, form: SimFormFields, opts?: SimClickOptions): SimClick;
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
  /**
   * The document that made the request: the page clicked on, the form's page, the attacker's page, the framed page.
   * Undefined for a navigation the victim's browser itself started (a link opened from mail): Sec-Fetch-Site none.
   */
  init?: SimInitiator;
  /** The cookie context (cookies.ts): same-site for cookies, and whether the top-level page navigates. */
  site: 'same' | 'cross';
  readonly topLevel: boolean;
  /** A navigation (Location and Refresh followed) or a CORS fetch (Location only; Origin always sent). */
  readonly mode: 'navigate' | 'cors';
  readonly dest: 'document' | 'iframe' | 'empty';
  /** Send and store cookies: always for a navigation, only with credentials: 'include' for a fetch. */
  readonly credentials: boolean;
  /** Add sec-fetch-* (every request but a WebSocket handshake, which carries none). */
  readonly shaped: boolean;
  /**
   * The victim's own action started it (a click, a typed or mailed link, a form it submitted): Sec-Fetch-User ?1,
   * kept across redirects; a page that moves on by itself starts a request no one clicked.
   */
  user: boolean;
  /** Headers the page's fetch() set (fetchHeaders); the body's Content-* ones go when a redirect drops the body. */
  extra?: Record<string, string>;
  /**
   * In a frame: the pages around it (the attacker's). Every page the frame would show is checked (framingOf); one
   * that refuses to be framed ends the visit there, unshown (so its Refresh never runs).
   */
  readonly ancestors?: readonly SimUrl[];
  /** The framing verdict on the last page the frame got (set by the loop). */
  framing?: SimFraming;
}

/**
 * Watches each citadel answer of a visit (`redirect`: it is followed next): return true to stop the visit there, on
 * that answer, as a page. corsFetch checks CORS on every answer; frame checks framing on every page it shows.
 */
type Watch = (req: SimRequest, res: SimResponse, h: ReadonlyMap<string, readonly string[]>, redirect: boolean) => boolean;

/** Where a visit starts. */
interface Start {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Payload;
  /** The page the request is made from (its Referer source) and its referrer policy. */
  readonly referrer?: SimUrl;
  readonly policy: ReferrerPolicy;
  /** What a relative `url` is relative to: the attacker page that made the request (the victim's own navigations take absolute URLs). */
  readonly base?: string;
}

export class Browser implements SimBrowser {
  private readonly jar: Jar;
  /** The frames this browser loaded; the shown ones keep what a click inside them needs. Weak: nothing is retained. */
  private readonly frames = new WeakMap<SimFrame, { readonly shown?: { readonly url: SimUrl; readonly policy: ReferrerPolicy }; readonly top: SimUrl }>();

  constructor(readonly world: World, private readonly handler: SimHandler) {
    this.jar = new Jar(() => world.now());
  }

  get cookies(): SimCookieJar { return this.jar; }

  follow(url: string, opts: SimNavigateOptions = {}): SimVisit {
    const referrer = citadelReferrer(opts);
    // From mail: the browser itself started it (Sec-Fetch-Site none). Clicked on a citadel page: that page did.
    return this.navigate({ method: 'GET', url, policy: DEFAULT_POLICY, ...(referrer ? { referrer } : {}) }, ownNavigation(referrer && initiatorOf(referrer)));
  }

  submit(url: string, form: Readonly<Record<string, string>>, opts: SimNavigateOptions = {}): SimVisit {
    const referrer = citadelReferrer(opts);
    const fields = formOf(form);
    const payload: Payload = { type: 'application/x-www-form-urlencoded', raw: new URLSearchParams(Object.entries(fields)).toString(), fields };
    // The form is on a citadel page: the referrer when given, else the page it posts to.
    return this.navigate({ method: 'POST', url, payload, policy: DEFAULT_POLICY, ...(referrer ? { referrer } : {}) }, ownNavigation(initiatorOf(referrer ?? classifySimUrl(url))));
  }

  crossSiteLink(url: string, opts: SimCrossSiteOptions = {}): SimVisit {
    const page = attackerPage(opts.page);
    return this.navigate({ method: 'GET', url, base: page.url.url, ...referrerOf(page), policy: page.policy }, fromPage(page));
  }

  crossSitePost(url: string, form: SimFormFields, opts: SimCrossSitePostOptions = {}): SimVisit {
    const page = attackerPage(opts.page);
    const { type, raw } = encodeForm(formEntries(form), formEnctype(opts.contentType));
    return this.navigate({ method: 'POST', url, payload: { type, raw, fields: bodyFields(type, raw) }, base: page.url.url, ...referrerOf(page), policy: page.policy }, fromPage(page));
  }

  corsFetch(url: string, opts: SimFetchOptions = {}): SimFetch {
    const page = attackerPage(opts.page);
    const { method = 'GET', credentials = 'same-origin', body } = opts;
    if (method !== 'GET' && method !== 'POST') throw new Error(`SimBrowser.corsFetch: method must be 'GET' or 'POST' (got ${JSON.stringify(method)})`);
    if (credentials !== 'omit' && credentials !== 'same-origin' && credentials !== 'include') {
      throw new Error(`SimBrowser.corsFetch: credentials must be 'omit', 'same-origin' or 'include' (got ${JSON.stringify(credentials)})`);
    }
    if (body !== undefined && typeof body !== 'string') throw new Error('SimBrowser.corsFetch: body must be a string');
    const headers = fetchHeaders(opts.headers);
    // fetch() throws before sending: a header it cannot carry, or a GET with a body.
    if (headers === undefined || (method === 'GET' && body !== undefined)) return Object.freeze({ sent: false, verdict: 'invalid' });
    if (body !== undefined && !Object.hasOwn(headers, 'content-type')) headers['content-type'] = 'text/plain;charset=UTF-8';
    if (classifySimUrl(url, page.url.url).site === 'citadel' && needsPreflight(method, headers)) return Object.freeze({ sent: false, verdict: 'preflight' });
    const type = headers['content-type'] ?? '';
    const payload: Payload | undefined = method === 'POST' ? { type, raw: body ?? '', fields: bodyFields(type, body ?? '') } : undefined;
    const withCredentials = credentials === 'include';
    let read: SimCorsRead | undefined;
    const visit = this.navigate(
      { method, url, ...(payload ? { payload } : {}), base: page.url.url, ...referrerOf(page), policy: page.policy },
      { init: page.init, site: 'cross', topLevel: false, mode: 'cors', dest: 'empty', credentials: withCredentials, shaped: true, user: false, extra: headers },
      (req, _res, h) => {
        read = corsCheck(h, req.headers.origin ?? 'null', withCredentials);
        return read !== 'readable'; // a failed check is a network error: the answer goes no further, not even a redirect
      },
    );
    if (visit.outcome !== 'page' || visit.page === undefined || read === undefined) return Object.freeze({ sent: true, verdict: 'no-answer', visit });
    const { status } = visit.page;
    return Object.freeze(read === 'readable' ? { sent: true, verdict: read, visit, status, body: visit.page.body } : { sent: true, verdict: read, visit, status });
  }

  frame(url: string, opts: SimFrameOptions = {}): SimFrame {
    if ((opts.page as SimAttackerPage | undefined)?.sandboxed !== undefined) throw new Error('SimBrowser.frame: a sandboxed framing page is not modelled');
    const page = attackerPage(opts.page);
    const ctx = inFrame(page.init, page.url);
    let policy: ReferrerPolicy = DEFAULT_POLICY;
    const visit = this.navigate({ method: 'GET', url, base: page.url.url, ...referrerOf(page), policy: page.policy }, ctx, (_req, _res, h, redirect) => {
      if (!redirect) policy = parsePolicy(h.get('referrer-policy')) ?? DEFAULT_POLICY; // the shown page's own policy
      return false;
    });
    const shownPage = visit.outcome === 'page' ? visit.page : undefined;
    const framed = shownPage !== undefined && ctx.framing === 'allowed';
    const frame: SimFrame = Object.freeze({
      framed, reason: shownPage === undefined ? 'not-loaded' : ctx.framing ?? 'not-loaded', visit, ancestor: page.url.origin,
      ...(framed ? { page: shownPage } : {}),
    });
    this.frames.set(frame, { top: page.url, ...(framed ? { shown: { url: classifySimUrl(shownPage.url), policy } } : {}) });
    return frame;
  }

  clickThrough(frame: SimFrame, action: string, form: SimFormFields, opts: SimClickOptions = {}): SimClick {
    const known = this.frames.get(frame);
    if (known === undefined) throw new Error('SimBrowser.clickThrough: pass a frame this browser loaded with frame()');
    if (known.shown === undefined) return Object.freeze({ clicked: false });
    const { url: from, policy } = known.shown;
    const resolved = classifySimUrl(str(action), from.url);
    const { type, raw } = encodeForm(formEntries(form), formEnctype(opts.contentType));
    const visit = this.navigate(
      { method: 'POST', url: resolved.site === 'other' ? str(action) : resolved.url, payload: { type, raw, fields: bodyFields(type, raw) }, referrer: from, policy },
      inFrame(initiatorOf(from), known.top, true),
    );
    return Object.freeze({ clicked: true, visit });
  }

  /**
   * The request loop shared by every navigation: citadel requests go to the handler, attacker.test requests to the
   * log (the visit ends there), anything else is unreachable. Redirects (Location on a redirect status) and pages that
   * move on by themselves (Refresh) are followed, at most SIM_LIMITS.maxRedirects; the same request again with the jar
   * unchanged is a loop.
   */
  private navigate(start: Start, ctx: Context, watch?: Watch): SimVisit {
    let { method, referrer, policy } = start;
    let payload = start.payload;
    let raw = str(start.url);
    let target = classifySimUrl(start.url, start.base);
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
      const cookie = ctx.credentials ? this.jar.headerFor(target, cookieCtx) : '';
      const headers: Record<string, string> = { host: target.host, 'user-agent': SIM_USER_AGENT, ...withReferer };
      if (cookie !== '') headers.cookie = cookie;
      if (method === 'POST' && payload !== undefined && payload.type !== '') headers['content-type'] = payload.type;
      const { init } = ctx;
      if (init !== undefined) {
        const origin = originHeader({ init, method, cors: ctx.mode === 'cors', target, policy, tainted: redirectTainted(init, urls) });
        if (origin !== undefined) headers.origin = clip(origin, SIM_LIMITS.urlLength);
      }
      if (ctx.shaped) {
        // A navigation the browser itself started stays `none` across redirects (Fetch Metadata).
        headers['sec-fetch-site'] = init === undefined ? 'none' : fetchSiteOf(init, urls);
        headers['sec-fetch-mode'] = ctx.mode;
        headers['sec-fetch-dest'] = ctx.dest;
        if (ctx.user) headers['sec-fetch-user'] = '?1';
      }
      for (const [name, value] of Object.entries(ctx.extra ?? {})) if (!Object.hasOwn(headers, name)) headers[name] = value;
      const req: SimRequest = Object.freeze({
        method, url: target.url, path: target.path, query: new URLSearchParams(target.search),
        headers: Object.freeze(headers), cookies: Object.freeze(parseCookieHeader(cookie)),
        body: Object.freeze(copyFields(payload?.fields)), rawBody: payload?.raw ?? '',
      });
      const res = checkResponse(this.handler(req));
      const h = headerMap(res);
      if (ctx.credentials) for (const line of h.get('set-cookie') ?? []) this.jar.store(line, target, cookieCtx);
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
      // A fetch follows redirects but never a Refresh (its answer is not a page).
      const location = REDIRECT_STATUSES.has(res.status) ? h.get('location')?.[0] : undefined;
      const refresh = location === undefined && ctx.mode === 'navigate' ? refreshTarget(h.get('refresh')?.[0]) : undefined;
      const page = (): SimVisit['page'] => ({ url: target.url, status: res.status, body: clip(res.body ?? '', SIM_LIMITS.bodyLength) });
      if (location === undefined && ctx.ancestors !== undefined) {
        ctx.framing = framingOf(h, target, ctx.ancestors);
        if (ctx.framing !== 'allowed') return finish('page', page());
      }
      if (watch?.(req, res, h, location !== undefined)) return finish('page', page());
      if (location === undefined && refresh === undefined) return finish('page', page());
      if (redirects >= SIM_LIMITS.maxRedirects) return finish('too-many-redirects');
      redirects++;
      if (location !== undefined) {
        // A redirect is not a page: the referrer stays the page that started the navigation; a Referrer-Policy
        // on the redirect response applies from here on (Fetch). 301/302 turn a POST into a GET, 303 always does.
        policy = parsePolicy(h.get('referrer-policy')) ?? policy;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          payload = undefined;
          if (ctx.extra !== undefined) ctx.extra = withoutBodyHeaders(ctx.extra);
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
        ctx.init = initiatorOf(target); // the citadel page now makes the request (no longer the browser itself)
        ctx.user = false; // nobody clicked: the page moves on by itself
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

/**
 * The victim's own navigation (a link from mail, a click or a form on a citadel page): same-site, top-level, started by
 * the victim's action (Sec-Fetch-User ?1). `init` is the citadel page it was on; none for a link opened from mail.
 */
function ownNavigation(init: SimInitiator | undefined): Context {
  return { ...(init ? { init } : {}), site: 'same', topLevel: true, mode: 'navigate', dest: 'document', credentials: true, shaped: true, user: true };
}

/** Fetch's request-body headers, which a redirect to GET removes along with the body. */
const BODY_HEADERS: ReadonlySet<string> = new Set(['content-encoding', 'content-language', 'content-location', 'content-type']);
function withoutBodyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(headers)) if (!BODY_HEADERS.has(k)) out[k] = v;
  return out;
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

/**
 * The Referer source of a request the attacker's page makes: the page, unless the request comes from a sandboxed frame.
 * A document with an opaque origin has no referrer (Fetch), so Chrome sends no Referer from it under any policy.
 */
function referrerOf(page: Page): { referrer?: SimUrl } {
  return page.sandboxed ? {} : { referrer: page.url };
}

/** A navigation the attacker's page starts: cross-site, in the top-level window unless it runs in a sandboxed frame. */
function fromPage(page: Page): Context {
  // The page's script navigates (an auto-submitted form, `location =`): no user activation, so no Sec-Fetch-User.
  return {
    init: page.init, site: 'cross', topLevel: !page.sandboxed, mode: 'navigate', dest: page.sandboxed ? 'iframe' : 'document',
    credentials: true, shaped: true, user: false, ...(page.sandboxed ? { ancestors: [page.url] } : {}),
  };
}

/**
 * A navigation in a frame on the attacker's page: cross-site for cookies (the top-level page is the attacker's).
 * `user`: the admin's own click (clickThrough) rather than the frame loading.
 */
function inFrame(init: SimInitiator, top: SimUrl, user = false): Context {
  return { init, site: 'cross', topLevel: false, mode: 'navigate', dest: 'iframe', credentials: true, shaped: true, user, ancestors: [top] };
}
