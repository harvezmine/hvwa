// _shared/twin.ts — one lab app, two browsers (docs/RECIPES.md section 8). A victim-driven lab's pages answer with a
// Reply that the citadel handler turns into a SimResponse for the simulated victim, and a real route sends to the
// player's real browser, with every redirect or forward going through sendSimRedirect (never off the lab).
// Plumbing only: which cookie, which Location, which Referrer-Policy is the level's decision, never this file's.
import type { Response } from 'express';
import { sendSimRedirect, type SimRedirectStatus, type SimResponse } from '../../../core/sim.js';

/** A lab cookie a page sets (or clears). Its path is the lab's base: labPath(res) for real routes, '/' on the citadel. */
export interface TwinCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Delete it instead (Max-Age=0). */
  readonly clear?: boolean;
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
      : `${c.name}=${c.value}; Path=${c.path}; HttpOnly; SameSite=Lax`));
  }
  return { status: r.status, headers, body: r.text };
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Answer the player's real browser with a Reply: its cookies always; a redirect, or a page that would move on by
 * itself, through sendSimRedirect (a citadel URL lands in the lab at the served level; anything else gets the "your
 * browser would go to" page); otherwise `render()` at the Reply's status.
 */
export async function sendReply(res: Response, r: Reply, render: () => Promise<void>): Promise<void> {
  for (const c of r.cookies ?? []) {
    if (c.clear) res.clearCookie(c.name, { path: c.path, httpOnly: true, sameSite: 'lax' });
    else res.cookie(c.name, c.value, { path: c.path, httpOnly: true, sameSite: 'lax' });
  }
  if (r.location !== undefined) {
    await sendSimRedirect(res, r.location, (REDIRECTS.has(r.status) ? r.status : 302) as SimRedirectStatus);
    return;
  }
  if (r.forward !== undefined) {
    await sendSimRedirect(res, r.forward);
    return;
  }
  res.status(r.status);
  await render();
}
