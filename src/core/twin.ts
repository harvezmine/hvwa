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
import { REDIRECT_STATUSES, type SimRequest, type SimResponse } from './sim/browser.js';
import { SIM_LIMITS } from './sim/limits.js';
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

/**
 * The real request as a Visit: the raw query (from req.originalUrl) and only the named lab cookies that are strings
 * (pass this level's names, e.g. `[sessionCookie(req.level)]`), with labPath(res) as the base.
 */
export function visitOf(req: Request, res: Response, cookieNames: readonly string[]): Visit {
  // Everything after the FIRST '?': a URL in a parameter (next=http://x/a?b=1&level=...) keeps its own '?' and the rest.
  // The slice keeps that first '?', which URLSearchParams drops (exactly one), so a query starting '??' keeps its second.
  const q = req.originalUrl.indexOf('?');
  return {
    level: req.level, query: new URLSearchParams(q === -1 ? '' : req.originalUrl.slice(q)),
    cookies: namedCookies(req.cookies, cookieNames), base: labPath(res),
  };
}

/**
 * The victim's request on the citadel as a Visit at `level`: its query as the simulated browser sent it, base ''. Pass
 * the same `cookieNames` as to visitOf, so a page function sees the same cookies in both browsers; without them every
 * cookie the simulated browser sent is kept (the behaviour before the filter existed).
 */
export function simVisitOf(level: Level, r: SimRequest, cookieNames?: readonly string[]): Visit {
  return { level, query: r.query, cookies: cookieNames === undefined ? r.cookies : namedCookies(r.cookies, cookieNames), base: '' };
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
