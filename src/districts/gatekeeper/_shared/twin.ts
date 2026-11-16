// _shared/twin.ts — one lab app, two browsers (docs/RECIPES.md section 8). A victim-driven lab's pages answer with a
// Reply that the citadel handler turns into a SimResponse for the simulated victim, and a real route sends to the
// player's real browser: every redirect through sendSimRedirect, and a page that would move on by itself rendered with
// a note instead (never a real Refresh, never a real Location off the lab).
// Plumbing only: which cookie, which Location, which Referrer-Policy is the level's decision, never this file's.
import type { Response } from 'express';
import { DEFAULT_LANG, isLang, type Lang } from '../../../core/i18n.js';
import { labPath } from '../../../core/lab.js';
import type { Text } from '../../../core/registry.js';
import {
  CITADEL_ORIGIN, SIM_LIMITS, classifySimUrl, labHref, sendSimRedirect, type SimRedirectStatus, type SimResponse,
} from '../../../core/sim.js';

/** A lab cookie a page sets (or clears). Its path is the lab's base: labPath(res) for real routes, '/' on the citadel. */
export interface TwinCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Delete it instead (Max-Age=0). */
  readonly clear?: boolean;
  /** Lifetime in seconds (Max-Age); omitted: a session cookie. */
  readonly maxAgeSec?: number;
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

/** A Reply as the simulated victim's browser receives it. */
export function toSim(r: Reply): SimResponse {
  const headers: Record<string, string | readonly string[]> = {};
  if (r.location !== undefined) headers.Location = r.location;
  if (r.forward !== undefined) headers.Refresh = `0; url=${r.forward}`;
  if (r.referrerPolicy !== undefined) headers['Referrer-Policy'] = r.referrerPolicy;
  if (r.cookies !== undefined && r.cookies.length > 0) {
    headers['Set-Cookie'] = r.cookies.map((c) => (c.clear
      ? `${c.name}=; Path=${c.path}; Max-Age=0; HttpOnly; SameSite=Lax`
      // The value URL-encoded, as res.cookie() encodes it; Max-Age runs on the world's clock in the simulated jar.
      : `${c.name}=${encodeURIComponent(c.value)}; Path=${c.path}${c.maxAgeSec === undefined ? '' : `; Max-Age=${c.maxAgeSec}`}; HttpOnly; SameSite=Lax`));
  }
  return { status: r.status, headers, body: r.text };
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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

const FORWARD_TEXT: Readonly<Record<'lead' | 'inLab' | 'away', Text>> = Object.freeze({
  lead: { id: 'Halaman ini memindahkan peramban dengan sendirinya ke:', en: 'This page moves the browser on by itself to:' },
  inLab: { id: 'Lanjutkan ke sana di lab', en: 'Continue there in the lab' },
  away: {
    id: 'Peramban Anda tetap di lab; hanya peramban korban tersimulasi yang benar-benar pergi ke sana.',
    en: 'Your browser stays in the lab; only the simulated victim\'s browser really goes there.',
  },
});

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
    ? { url, lead: FORWARD_TEXT.lead[lang], action: FORWARD_TEXT.away[lang] }
    : { url, href, lead: FORWARD_TEXT.lead[lang], action: FORWARD_TEXT.inLab[lang] };
}

/**
 * Answer the player's real browser with a Reply, as the simulated browser reads the same Reply:
 * - its cookies, always;
 * - a Location only on a redirect status (301, 302, 303, 307, 308), through sendSimRedirect (a citadel URL lands in the
 *   lab at the served level; anything else gets the "your browser would go to" page). A Location on any other status
 *   is ignored, as the simulated browser ignores it;
 * - otherwise `render(forward)` at the Reply's status. For a page that moves on by itself (`forward`), render gets the
 *   ForwardNote to show (the lab's view includes `_shared/views/forward-note.ejs`): the page is rendered, its message
 *   (and a flag) included, and the browser is never sent on, so a forward off the lab is never a real redirect.
 */
export async function sendReply(res: Response, r: Reply, render: (forward?: ForwardNote) => Promise<void>): Promise<void> {
  for (const c of r.cookies ?? []) {
    if (c.clear) res.clearCookie(c.name, { path: c.path, httpOnly: true, sameSite: 'lax' });
    else {
      res.cookie(c.name, c.value, {
        path: c.path, httpOnly: true, sameSite: 'lax', ...(c.maxAgeSec === undefined ? {} : { maxAge: c.maxAgeSec * 1000 }),
      });
    }
  }
  if (r.location !== undefined && REDIRECTS.has(r.status)) {
    await sendSimRedirect(res, r.location, r.status as SimRedirectStatus);
    return;
  }
  res.status(r.status);
  await render(r.forward === undefined ? undefined : forwardNote(res, r.forward));
}
