// src/auth/forms.ts — the platform's form guards, shared by every router that renders a platform form (login,
// registration, account, range actions). PLATFORM code (docs/SECURITY.md "The platform login").
import type { Request, RequestHandler, Response } from 'express';
import { SCOPED_PAGE_CSP } from '../core/page-csp.js';
import { AUTH_COOKIE } from './service.js';

/**
 * Platform pages of the login: never cached, never framed (no clickjacking of the password forms). An already-set
 * Content-Security-Policy is kept: on a range page (or a refusal rendered from one) that is the router's scoped policy,
 * which this must not replace with the narrower frame-ancestors directive.
 */
export function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  if (res.getHeader('Content-Security-Policy') === undefined) {
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
}

/**
 * The per-response headers every platform page gets: keyed on the session cookie, nosniff, and the scoped page CSP.
 * Mounted on the auth routers too (publicRouter / accountRouter), which sit outside portal.router.
 */
export function scopedPageHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.vary('Cookie');
    res.set('X-Content-Type-Options', 'nosniff');
    if (res.getHeader('Content-Security-Policy') === undefined) {
      res.set('Content-Security-Policy', SCOPED_PAGE_CSP);
    }
    next();
  };
}

export const isApi = (req: Request) => /^\/api(?:\/|$)/i.test(req.path);
export const isHtmx = (req: Request) => req.get('HX-Request') === 'true';

/** The request's own origin host (Host header, normalised like URL.host: lowercased, default port dropped). */
export function ownHost(req: Request): string | undefined {
  try { return new URL(`http://${req.headers.host ?? ''}`).host; } catch { return undefined; }
}

/**
 * Same-origin check for the forms: an absent Origin passes (older clients, curl; the synchroniser token still
 * applies), a present one must be exactly this origin: `scheme` (default the request's own, req.protocol: 'http', as
 * 'trust proxy' is off, so X-Forwarded-Proto cannot change it; in portal mode the configured public scheme, because TLS
 * ends at Cloudflare and the portal only ever sees plain http) and the Host, port included. 'null', another port of the
 * same host and every other origin are refused.
 */
export function originOk(req: Request, scheme: string = req.protocol): boolean {
  const origin = req.get('origin');
  if (origin === undefined) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  return u.protocol === `${scheme}:` && u.origin === origin.toLowerCase() && u.host === ownHost(req);
}

/**
 * Fetch metadata: a browser marks every request with Sec-Fetch-Site. The forms accept only 'same-origin' (a page of
 * ours posting), or no header at all (older clients, curl). 'same-site' (another port of this host, or in portal mode
 * a lab host under the same domain), 'cross-site' and 'none' are refused: 'none' is a user-typed navigation, which is
 * never a form POST.
 */
export function fetchSiteOk(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  return site === undefined || site.trim().toLowerCase() === 'same-origin';
}

/** The hvwa_auth cookie as presented (a string, else ''). */
export function authTokenOf(req: Request): string {
  const v: unknown = req.cookies?.[AUTH_COOKIE];
  return typeof v === 'string' ? v : '';
}

/**
 * After the gate, at the top of a Router: an admin goes on; anyone else leaves the router (next('router')) and gets the
 * same 404 as any unknown page, so admin-only pages are not even advertised.
 */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals.platformAuth?.role === 'admin') next();
  else next('router');
};
