// src/core/theme.ts — the colour theme preference (the layout's light/dark toggle).
import type { RequestHandler } from 'express';
import { cookieOptionsWith, preference } from './cookies.js';

/** 'system' follows prefers-color-scheme (no data-theme on <html>); 'dark' / 'light' are explicit choices. */
export const THEMES = Object.freeze(['system', 'dark', 'light'] as const);
export type Theme = (typeof THEMES)[number];

export function isTheme(x: unknown): x is Theme {
  return typeof x === 'string' && (THEMES as readonly string[]).includes(x);
}

/**
 * res.locals.uiTheme = valid ?theme= → valid hvwa_theme cookie → 'system' (the same query → cookie → fallback
 * resolver as ?lang= and ?level=). Presentation only: the toggle is a plain link, so it works without JavaScript,
 * and the server renders the chosen theme on the next page (no flash of the wrong theme).
 */
export function themeMiddleware(opts: { readonly secureCookies?: boolean } = {}): RequestHandler {
  const cookieOptions = cookieOptionsWith(opts.secureCookies === true);
  return (req, res, next) => {
    res.locals.uiTheme = preference<Theme>(
      req, res, { query: 'theme', cookie: 'hvwa_theme', isValid: isTheme, fallback: 'system' }, cookieOptions,
    );
    res.locals.prefQuery = keptQuery(req.originalUrl);
    next();
  };
}

/** A kept query longer than this is dropped: every toggle copies it, and a lab page has a 16 KiB budget. */
export const KEPT_QUERY_MAX = 512;

/**
 * Params a toggle never carries over: its own two, and the portal's one-shot flag-result params (r, lvl, g in
 * portal/index.ts), so switching language never replays a result and g (the points) is never rendered.
 */
const DROPPED_PARAMS = Object.freeze(['lang', 'theme', 'r', 'lvl', 'g']);

/**
 * The prefix the language and theme toggles put before their own param: the page's query minus DROPPED_PARAMS,
 * re-serialised (so every value is percent-encoded) and followed by '&'; '' when nothing is kept. Switching
 * language on /login?next=/d/x or on a lab's search results then keeps next= and the search.
 */
export function keptQuery(originalUrl: string): string {
  const at = originalUrl.indexOf('?');
  if (at < 0) return '';
  const params = new URLSearchParams(originalUrl.slice(at + 1));
  for (const name of DROPPED_PARAMS) params.delete(name);
  const kept = params.toString();
  return kept === '' || kept.length > KEPT_QUERY_MAX ? '' : `${kept}&`;
}
