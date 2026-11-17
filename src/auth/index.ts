// src/auth/index.ts — the platform login's routes and gate (createApp({ auth })). PLATFORM code, secure
// by design: the labs behind it are the vulnerable part, this is not (docs/SECURITY.md "The platform login").
//
//   publicRouter   GET/POST /login                         (before the gate)
//   gate           everything mounted after it needs a live hvwa_auth token
//   accountRouter  POST /logout, GET/POST /account/password (after the gate)
//
// createApp mounts /static and /healthz BEFORE publicRouter, so they stay open; anything that falls
// through them (a missing asset) reaches the gate like any other path.
import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { safeNext } from './next.js';
import { AUTH_COOKIE, AUTH_LIMITS, createAuthService, type AuthService, type AuthServiceOptions } from './service.js';

export { safeNext } from './next.js';
export type { AuthService } from './service.js';

/** createApp's `auth` option as an object (`auth: true` = all defaults). */
export type AuthOptions = AuthServiceOptions;

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(viewsDir, `${name}.ejs`);

// Explicit attributes: HttpOnly (no script reads it), SameSite=Lax (cross-site subrequests and posts never
// carry it), Path=/, Max-Age = the token's absolute lifetime. No Domain (host-only). Not Secure: HVWA is
// served over plain http on loopback, where a Secure cookie would be dropped by most clients.
const COOKIE: Readonly<CookieOptions> = Object.freeze({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: AUTH_LIMITS.tokenTtlMs });
const CLEAR: Readonly<CookieOptions> = Object.freeze({ httpOnly: true, sameSite: 'lax', path: '/' });

/** Platform pages of the login: never cached, never framed (no clickjacking of the password forms). */
function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
}

const isApi = (req: Request) => /^\/api(?:\/|$)/i.test(req.path);
const isHtmx = (req: Request) => req.get('HX-Request') === 'true';

/** The request's own origin host (Host header, normalised like URL.host: lowercased, default port dropped). */
function ownHost(req: Request): string | undefined {
  try { return new URL(`http://${req.headers.host ?? ''}`).host; } catch { return undefined; }
}

/**
 * Same-origin check for the forms: an absent Origin passes (older clients, curl; the synchroniser token
 * still applies), a present one must be http(s)://<this Host>. 'null' and other origins are refused.
 */
function originOk(req: Request): boolean {
  const origin = req.get('origin');
  if (origin === undefined) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin.toLowerCase() && u.host === ownHost(req);
}

/** Where the login page should return a signed-out request to. */
function nextFor(req: Request): string {
  if (isHtmx(req)) {
    // htmx swaps fragments: return to the PAGE it came from (HX-Current-URL), if it is ours.
    const current = req.get('HX-Current-URL');
    if (!current) return '/';
    try {
      const u = new URL(current);
      return u.host === ownHost(req) ? safeNext(`${u.pathname}${u.search}`) : '/';
    } catch { return '/'; }
  }
  return req.method === 'GET' || req.method === 'HEAD' ? safeNext(req.originalUrl) : '/';
}

const loginHref = (next: string) => `/login?next=${encodeURIComponent(next)}`;

export interface PlatformAuth {
  readonly service: AuthService;
  readonly publicRouter: Router;
  readonly gate: RequestHandler;
  readonly accountRouter: Router;
}

/** The login for one app over its platform DB (creates the admin account on first use). */
export function platformAuth(db: DatabaseSync, opts: AuthOptions = {}): PlatformAuth {
  const service = createAuthService(db, opts);

  const refuse = async (req: Request, res: Response, back: string) => {
    noStore(res);
    res.locals.platformAuth ??= { signedIn: false }; // /login is before the gate
    res.status(403);
    await sendPage(res, view('refused'), { pageTitle: res.locals.t('auth.csrf_heading'), back });
  };
  /** The form's synchroniser token (per hvwa_sid) and the Origin check. */
  const formOk = (req: Request) => originOk(req) && service.checkCsrf(req.sessionId, field(req, '_csrf'));

  const renderLogin = (req: Request, res: Response, next: string, failed: boolean) => {
    noStore(res);
    res.locals.platformAuth = { signedIn: false };
    return sendPage(res, view('login'), {
      pageTitle: res.locals.t('auth.login_heading'), csrf: service.csrfToken(req.sessionId), next, failed,
    });
  };

  const publicRouter = Router();
  publicRouter.get('/login', async (req, res) => {
    const next = safeNext(req.query.next);
    if (service.session(req.cookies?.[AUTH_COOKIE])) { noStore(res); res.redirect(303, next); return; }
    await renderLogin(req, res, next, false);
  });
  publicRouter.post('/login', async (req, res) => {
    if (!formOk(req)) { await refuse(req, res, '/login'); return; }
    const next = safeNext(field(req, 'next'));
    const result = await service.signIn(field(req, 'username'), field(req, 'password'));
    if (!result.ok) {
      res.status(401);
      await renderLogin(req, res, next, true);
      return;
    }
    service.revoke(req.cookies?.[AUTH_COOKIE]); // a fresh token per sign-in; the old one dies
    noStore(res);
    res.cookie(AUTH_COOKIE, result.token, COOKIE);
    res.redirect(303, next);
  });

  const gate: RequestHandler = (req, res, next) => {
    const presented: unknown = req.cookies?.[AUTH_COOKIE];
    const session = service.session(presented);
    if (session) {
      res.locals.platformAuth = {
        signedIn: true, user: session.username, defaultPassword: session.defaultPassword,
        csrf: service.csrfToken(req.sessionId),
      };
      next();
      return;
    }
    if (presented !== undefined) res.clearCookie(AUTH_COOKIE, CLEAR); // stale, revoked or forged
    res.set('Cache-Control', 'no-store');
    if (isApi(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = loginHref(nextFor(req));
    if (isHtmx(req)) {
      res.status(401).set('HX-Redirect', target).type('html').send('<p data-error="401" role="alert">401</p>');
      return;
    }
    res.redirect(303, target);
  };

  const accountRouter = Router();
  accountRouter.post('/logout', async (req, res) => {
    if (!formOk(req)) { await refuse(req, res, '/'); return; }
    service.revoke(req.cookies?.[AUTH_COOKIE]);
    noStore(res);
    res.clearCookie(AUTH_COOKIE, CLEAR);
    res.redirect(303, '/login');
  });

  const renderPassword = (req: Request, res: Response, data: { error?: string; changed?: boolean }) => {
    noStore(res);
    return sendPage(res, view('password'), {
      pageTitle: res.locals.t('auth.pw_heading'), csrf: service.csrfToken(req.sessionId),
      user: res.locals.platformAuth?.user ?? '', error: data.error, changed: data.changed === true,
    });
  };
  accountRouter.get('/account/password', async (req, res) => {
    await renderPassword(req, res, { changed: req.query.changed === '1' });
  });
  accountRouter.post('/account/password', async (req, res) => {
    if (!formOk(req)) { await refuse(req, res, '/account/password'); return; }
    const username = res.locals.platformAuth?.user ?? '';
    const result = await service.changePassword(username, field(req, 'current'), field(req, 'password'), field(req, 'confirm'));
    if (!result.ok) {
      res.status(400);
      await renderPassword(req, res, { error: result.error });
      return;
    }
    noStore(res);
    res.cookie(AUTH_COOKIE, result.token, COOKIE); // every other token is gone; this browser stays signed in
    res.redirect(303, '/account/password?changed=1');
  });

  return Object.freeze({ service, publicRouter, gate, accountRouter });
}
