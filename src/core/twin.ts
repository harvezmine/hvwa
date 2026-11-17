// src/core/twin.ts — one lab app, two browsers (docs/RECIPES.md section 8). A victim-driven lab's pages answer with a
// Reply that the citadel handler turns into a SimResponse for the simulated victim (toSim), and a real route sends to the
// player's real browser (sendReply): every redirect through sendSimRedirect, and a page that would move on by itself
// rendered with a note instead (never a real Refresh, never a real Location off the lab). A Visit is what such a page
// needs from either browser's request (visitOf for the real one, simVisitOf on the citadel).
// Plumbing only: which cookie (and its attributes), which Location, which Referrer-Policy is the level's decision, never
// this file's. Imported through core/sim.ts.
import type { Request, Response } from 'express';
import { DEFAULT_LANG, isLang, t, type Lang } from './i18n.js';
import { labPath } from './lab.js';
import type { Level } from './levels.js';
import { Buffer } from 'node:buffer';
import { REDIRECT_STATUSES, type SimRequest, type SimResponse } from './sim/browser.js';
import { bodyFields, mimeEssence } from './sim/cross.js';
import { SIM_LIMITS, clip, str } from './sim/limits.js';
import { CITADEL_ORIGIN, classifySimUrl, labHref } from './sim/url.js';
import { sendSimRedirect, type SimRedirectStatus } from './victim.js';

/** A cookie's SameSite, as the Set-Cookie line spells it. */
export type TwinSameSite = 'Strict' | 'Lax' | 'None';
const SAME_SITES: ReadonlySet<string> = new Set<TwinSameSite>(['Strict', 'Lax', 'None']);

/** A lab cookie a page sets (or clears). Its path is the lab's base: cookiePath(base). */
export interface TwinCookie {
  readonly name: string;
  readonly value: string;
  /** labPath(res) on a real route, '/' on the citadel: cookiePath(base). */
  readonly path: string;
  /** Delete it instead (Max-Age=0). */
  readonly clear?: boolean;
  /** Lifetime in seconds (Max-Age); omitted: a session cookie. */
  readonly maxAgeSec?: number;
  /**
   * Default true (a session id: say in the view how to edit it, devtools storage or `curl -b`). false for a cookie the
   * lab means the page's script, and the player, to read or write.
   */
  readonly httpOnly?: boolean;
  /**
   * Default 'Lax', as `hvwa_sid`. A lab whose lesson is SameSite (CSRF) sets it per level, in the level file, so View
   * Source shows it. 'None' needs `secure: true` (it throws otherwise): browsers drop `SameSite=None` without Secure.
   */
  readonly sameSite?: TwinSameSite;
  /**
   * Default false. A browser keeps a Secure cookie only from a secure context. The simulated browser treats
   * http://citadel.test as one, as browsers treat loopback, so it keeps a Secure cookie from it (and sends it back over
   * http); the player's own browser treats http://127.0.0.1 as secure in Chromium and Firefox, maybe not in Safari.
   */
  readonly secure?: boolean;
}

/** One answer of a lab page, for either browser. */
export interface Reply {
  readonly status: number;
  /** A redirect (with a 3xx status) to this URL. */
  readonly location?: string;
  /** A page that moves the browser on by itself to this URL (the sim's Refresh: it sends the page's URL as Referer). */
  readonly forward?: string;
  /** The page's (or the redirect's) Referrer-Policy. */
  readonly referrerPolicy?: string;
  readonly cookies?: readonly TwinCookie[];
  /** The page's message (lab content, English). */
  readonly text: string;
}

/** The cookie path a level function uses for its base: '' (the citadel) is '/'. */
export const cookiePath = (base: string): string => base || '/';

/**
 * A cookie's attributes with the defaults applied (HttpOnly, SameSite=Lax, not Secure). Throws on an unknown SameSite,
 * and on SameSite=None without `secure: true` (set or cleared): browsers drop that cookie, so a lab would test nothing.
 */
function attributesOf(c: TwinCookie): { readonly httpOnly: boolean; readonly sameSite: TwinSameSite; readonly secure: boolean } {
  const sameSite: unknown = c.sameSite ?? 'Lax';
  if (typeof sameSite !== 'string' || !SAME_SITES.has(sameSite)) {
    throw new Error(`TwinCookie "${c.name}": sameSite must be 'Strict', 'Lax' or 'None' (got ${JSON.stringify(sameSite)})`);
  }
  const secure = c.secure === true;
  if (sameSite === 'None' && !secure) {
    throw new Error(`TwinCookie "${c.name}": sameSite 'None' needs secure: true (browsers drop a SameSite=None cookie that is not Secure)`);
  }
  return { httpOnly: c.httpOnly ?? true, sameSite: sameSite as TwinSameSite, secure };
}

/** The Set-Cookie line the simulated browser receives for `c`. */
function setCookieLine(c: TwinCookie): string {
  const a = attributesOf(c);
  const flags = `${a.httpOnly ? '; HttpOnly' : ''}; SameSite=${a.sameSite}${a.secure ? '; Secure' : ''}`;
  if (c.clear) return `${c.name}=; Path=${c.path}; Max-Age=0${flags}`;
  // The value URL-encoded, as res.cookie() encodes it; Max-Age runs on the world's clock in the simulated jar.
  return `${c.name}=${encodeURIComponent(c.value)}; Path=${c.path}${c.maxAgeSec === undefined ? '' : `; Max-Age=${c.maxAgeSec}`}${flags}`;
}

/** A Reply as the simulated victim's browser receives it. */
export function toSim(r: Reply): SimResponse {
  const headers: Record<string, string | readonly string[]> = {};
  if (r.location !== undefined) headers.Location = r.location;
  if (r.forward !== undefined) headers.Refresh = `0; url=${r.forward}`;
  if (r.referrerPolicy !== undefined) headers['Referrer-Policy'] = r.referrerPolicy;
  if (r.cookies !== undefined && r.cookies.length > 0) headers['Set-Cookie'] = r.cookies.map(setCookieLine);
  return { status: r.status, headers, body: r.text };
}

/** What the real browser is shown for a page that moves on by itself (Reply.forward), instead of following it. */
export interface ForwardNote {
  /** Where the page moves the browser on to: a citadel URL as the victim's browser resolves it, anything else as given. */
  readonly url: string;
  /** The same place in the lab, for a citadel target; undefined for anything else (shown as text only). */
  readonly href?: string;
  /** The note's words, in the player's language: what the page does, and the link text or why there is no link. */
  readonly lead: string;
  readonly action: string;
}

/**
 * The note for a forward to `target`, resolved as sendSimRedirect resolves a Location: a path under labPath(res) is
 * that path on the citadel; anything else is resolved against the citadel twin of this route. A citadel URL gets a
 * link to the same place in the lab at the served level (labHref); every other URL is text only.
 */
export function forwardNote(res: Response, target: string): ForwardNote {
  const base = labPath(res);
  const lang: Lang = isLang(res.locals.lang) ? res.locals.lang : DEFAULT_LANG;
  const local = target === base || ['/', '?', '#'].some((c) => target.startsWith(`${base}${c}`));
  const u = local
    ? classifySimUrl(`${CITADEL_ORIGIN}${target.slice(base.length)}`)
    : classifySimUrl(target, `${CITADEL_ORIGIN}${res.req.path}`);
  const href = labHref(u, base, res.req.level);
  const url = u.url || target.slice(0, SIM_LIMITS.urlLength);
  return href === undefined
    ? { url, lead: t('sim.forward.lead', lang), action: t('sim.forward.away', lang) }
    : { url, href, lead: t('sim.forward.lead', lang), action: t('sim.forward.in_lab', lang) };
}

/**
 * Answer the player's real browser with a Reply, as the simulated browser reads the same Reply:
 * - its cookies, always, with their attributes (default HttpOnly and SameSite=Lax);
 * - a Location only on a redirect status (REDIRECT_STATUSES: 301, 302, 303, 307, 308), through sendSimRedirect (a
 *   citadel URL lands in the lab at the served level; anything else gets the "your browser would go to" page). A
 *   Location on any other status is ignored, as the simulated browser ignores it;
 * - otherwise `render(forward)` at the Reply's status. For a page that moves on by itself (`forward`), render gets the
 *   ForwardNote to show (the lab's view includes `core/views/forward-note.ejs`): the page is rendered, its message
 *   (and a flag) included, and the browser is never sent on, so a forward off the lab is never a real redirect.
 */
export async function sendReply(res: Response, r: Reply, render: (forward?: ForwardNote) => Promise<void>): Promise<void> {
  // Every cookie is checked before any is set: a refused one fails the whole Reply, never half of it.
  const checked = (r.cookies ?? []).map((c) => ({ c, a: attributesOf(c) }));
  for (const { c, a } of checked) {
    const opts = {
      path: c.path, httpOnly: a.httpOnly, sameSite: a.sameSite.toLowerCase() as 'strict' | 'lax' | 'none',
      ...(a.secure ? { secure: true } : {}),
    };
    if (c.clear) res.clearCookie(c.name, opts);
    else res.cookie(c.name, c.value, { ...opts, ...(c.maxAgeSec === undefined ? {} : { maxAge: c.maxAgeSec * 1000 }) });
  }
  if (r.location !== undefined && REDIRECT_STATUSES.has(r.status)) {
    await sendSimRedirect(res, r.location, r.status as SimRedirectStatus);
    return;
  }
  res.status(r.status);
  await render(r.forward === undefined ? undefined : forwardNote(res, r.forward));
}

/** What a lab page needs from a browser's request, whichever browser sent it. */
export interface Visit {
  readonly level: Level;
  /** The raw query string, every value kept (never Express's parsed req.query). */
  readonly query: URLSearchParams;
  /** The lab's own cookies by name (strings only, null prototype). */
  readonly cookies: Readonly<Record<string, string | undefined>>;
  /** Where the lab lives for this browser: labPath(res) on a real route, '' on the citadel. */
  readonly base: string;
}

/** The bounds on what a RequestVisit copies out of a request. */
export const TWIN_LIMITS = Object.freeze({
  /** A header value: one past the URL cap, so an over-long Origin or Referer stays too long to be a sim URL. */
  headerLength: SIM_LIMITS.urlLength + 1,
  /** The body as text, and each body field: what twinBody() reads at most (8 KiB). */
  textLength: 8 * 1024,
});

/**
 * The request headers every RequestVisit carries when present (lower-case): what a CSRF, CORS or clickjacking level
 * checks. A lab adds its own with `headerNames` (visitOf / simVisitOf). Never cookie, host or user-agent.
 */
export const VISIT_HEADERS: readonly string[] = Object.freeze([
  'origin', 'referer', 'content-type', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'x-requested-with',
]);

/**
 * A Visit with the request itself (E1b), for the levels whose lesson is where a request came from (FP-01 to FP-04):
 * `visitOf` and `simVisitOf` return one. Every value is a bounded copy (TWIN_LIMITS); records have no prototype.
 */
export interface RequestVisit extends Visit {
  /** 'GET' or 'POST' (the real route: its method as Express has it). */
  readonly method: string;
  /** VISIT_HEADERS and the ones the lab named, lower-case, when the request had them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * The body's string fields, as bodyFields reads `text`: an urlencoded form's (a repeated name keeps its first value),
   * a JSON object's string members; none for any other body (text/plain: read `text`).
   */
  readonly body: Readonly<Record<string, string>>;
  /**
   * The body as text. In the sim it is the body as sent. On the real route the app's own parsers have already read a
   * JSON or urlencoded body, so it is re-serialised from req.body (the same fields, not byte for byte: key order and
   * escapes may differ); a text/plain body is read whole only on a route that mounts twinBody(). '' for a GET.
   */
  readonly text: string;
  /**
   * This browser's own origin for the lab: CITADEL_ORIGIN in the sim, `<protocol>://<Host>` on the real route. A level
   * that checks Origin compares `visit.headers.origin === visit.self`, never a hard-coded citadel origin (the player's
   * browser sends `http://127.0.0.1:<port>`).
   */
  readonly self: string;
}

/**
 * The real request as a Visit: the raw query (from req.originalUrl) and only the named lab cookies that are strings
 * (pass this level's names, e.g. `[sessionCookie(req.level)]`), with labPath(res) as the base; plus the request
 * (RequestVisit): its method, VISIT_HEADERS and `headerNames`, its body, and the lab's own origin as `self`.
 */
export function visitOf(req: Request, res: Response, cookieNames: readonly string[], headerNames: readonly string[] = []): RequestVisit {
  // Everything after the FIRST '?': a URL in a parameter (next=http://x/a?b=1&level=...) keeps its own '?' and the rest.
  // The slice keeps that first '?', which URLSearchParams drops (exactly one), so a query starting '??' keeps its second.
  const q = req.originalUrl.indexOf('?');
  const type = str(req.headers?.['content-type']);
  const host = typeof req.get === 'function' ? req.get('host') : undefined;
  return {
    level: req.level, query: new URLSearchParams(q === -1 ? '' : req.originalUrl.slice(q)),
    cookies: namedCookies(req.cookies, cookieNames), base: labPath(res),
    method: str(req.method) || 'GET', headers: namedHeaders(req.headers, headerNames), ...bodyOf(type, textOfBody(type, req.body)),
    self: clip(`${str(req.protocol) || 'http'}://${host ?? ''}`, TWIN_LIMITS.headerLength),
  };
}

/**
 * The victim's request on the citadel as a Visit at `level`: its query as the simulated browser sent it, base ''. Pass
 * the same `cookieNames` as to visitOf, so a page function sees the same cookies in both browsers; without them every
 * cookie the simulated browser sent is kept (the behaviour before the filter existed). The request as for visitOf, with
 * `self` = CITADEL_ORIGIN; pass the same `headerNames` too.
 */
export function simVisitOf(level: Level, r: SimRequest, cookieNames?: readonly string[], headerNames: readonly string[] = []): RequestVisit {
  return {
    level, query: r.query, cookies: cookieNames === undefined ? r.cookies : namedCookies(r.cookies, cookieNames), base: '',
    method: str(r.method) || 'GET', headers: namedHeaders(r.headers, headerNames), ...bodyOf(str(r.headers?.['content-type']), str(r.rawBody)),
    self: CITADEL_ORIGIN,
  };
}

/** VISIT_HEADERS and the lab's names that the request has as strings, lower-case keys, values clipped copies. */
function namedHeaders(from: unknown, headerNames: readonly string[]): Record<string, string | undefined> {
  const raw = (from ?? {}) as Record<string, unknown>;
  const out: Record<string, string | undefined> = Object.create(null);
  for (const name of [...VISIT_HEADERS, ...headerNames.map((h) => h.toLowerCase())]) {
    const value = raw[name];
    if (typeof value === 'string' && !Object.hasOwn(out, name)) out[name] = clip(value, TWIN_LIMITS.headerLength);
  }
  return out;
}

/** The body's fields (from the whole text, each a clipped copy) and the text, clipped. */
function bodyOf(type: string, text: string): { readonly body: Record<string, string>; readonly text: string } {
  const body = bodyFields(type, text);
  for (const k of Object.keys(body)) body[k] = clip(body[k], TWIN_LIMITS.textLength);
  return { body, text: clip(text, TWIN_LIMITS.textLength) };
}

/**
 * The real route's body as text. A string is what twinBody() (express.text) read. An object is what the app's own
 * express.json() or express.urlencoded() made of it: re-serialised, as JSON or as a form (nested names as `a[b]`,
 * arrays as repeated names), so bodyFields reads the same fields the sim reads from the raw bytes. Anything else is ''.
 */
function textOfBody(type: string, body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === null || typeof body !== 'object' || Buffer.isBuffer(body)) return '';
  const essence = mimeEssence(type);
  if (essence === 'application/json') return JSON.stringify(body);
  if (essence !== 'application/x-www-form-urlencoded') return '';
  const pairs: [string, string][] = [];
  const walk = (name: string, v: unknown, depth: number): void => {
    if (typeof v === 'string') pairs.push([name, v]);
    else if (Array.isArray(v)) for (const x of v) walk(name, x, depth + 1);
    else if (v !== null && typeof v === 'object' && depth < 8) for (const [k, x] of Object.entries(v)) walk(name === '' ? k : `${name}[${k}]`, x, depth + 1);
  };
  walk('', body, 0);
  return new URLSearchParams(pairs).toString();
}

/** Only the named cookies that are strings, in a null-prototype record (no name can reach Object.prototype). */
function namedCookies(from: unknown, cookieNames: readonly string[]): Record<string, string | undefined> {
  const raw = (from ?? {}) as Record<string, unknown>;
  const cookies: Record<string, string | undefined> = Object.create(null);
  for (const name of cookieNames) {
    const value = raw[name];
    if (typeof value === 'string') cookies[name] = value;
  }
  return cookies;
}
