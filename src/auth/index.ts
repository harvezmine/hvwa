// src/auth/index.ts — the platform login's routes and gate (createApp({ auth })). PLATFORM code, secure
// by design: the labs behind it are the vulnerable part, this is not (docs/SECURITY.md "The platform login").
//
//   publicRouter   GET/POST /login, GET/POST /register (portal mode only)   (before the gate)
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
import { clientIp } from './client-ip.js';
import { authTokenOf, fetchSiteOk, isApi, isHtmx, noStore, originOk, ownHost } from './forms.js';
import { windowLimiter } from './rate-limit.js';
import { registrationRouter, type RegistrationOptions } from './register.js';
import { AUTH_COOKIE, AUTH_LIMITS, createAuthService, type AuthService, type AuthServiceOptions } from './service.js';

export { safeNext } from './next.js';
export { requireAdmin } from './forms.js';
export type { AuthService, AuthSession, Role, UserSummary } from './service.js';
export type { RegistrationOptions } from './register.js';

/** The failed-sign-in budget per client IP in portal mode (createApp). */
export const SIGN_IN_PER_IP_DEFAULTS = Object.freeze({ max: 30, windowMs: 15 * 60_000 });

/** createApp's `auth` option as an object (`auth: true` = all defaults). */
export interface AuthOptions extends AuthServiceOptions {
  /**
   * Give hvwa_auth the Secure attribute: portal mode behind the Cloudflare Tunnel (public scheme https). Off by default:
   * standalone serves plain http on loopback, where a Secure cookie would be dropped by most clients.
   */
  secureCookies?: boolean;
  /**
   * The scheme the BROWSER uses (portal mode: HVWA_RANGE_PUBLIC_SCHEME). The forms' Origin check compares against it,
   * since behind the tunnel the portal itself only sees plain http. Default: the request's own scheme.
   */
  publicScheme?: 'http' | 'https';
  /**
   * Mount GET/POST /register (portal mode); `open: false` (HVWA_REGISTRATION_OPEN=0) shows it closed. Absent: no
   * registration at all (standalone).
   */
  registration?: RegistrationOptions;
  /**
   * Portal mode: at most `max` FAILED sign-ins per client IP (clientIp) per `windowMs`; beyond it a sign-in is refused
   * before any password check (429). In front of, not instead of, the per-account backoff. Absent: off (standalone).
   */
  signInPerIp?: { readonly max: number; readonly windowMs: number };
}

export const authViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(authViewsDir, `${name}.ejs`);

// Explicit attributes: HttpOnly (no script reads it), SameSite=Lax (cross-site subrequests and posts never carry it),
// Path=/, Max-Age = the token's absolute lifetime, Secure only behind HTTPS (portal mode). No Domain (host-only).
function cookieAttributes(secure: boolean): { set: Readonly<CookieOptions>; clear: Readonly<CookieOptions> } {
  const base = { httpOnly: true, sameSite: 'lax', path: '/', ...(secure ? { secure: true } : {}) } as const;
  return { set: Object.freeze({ ...base, maxAge: AUTH_LIMITS.tokenTtlMs }), clear: Object.freeze({ ...base }) };
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

// Every check slot is taken (AUTH_LIMITS.checksInFlight / checksQueued): the attempt was not checked at all.
// Kept here, not in the platform dictionary, so the login stays self-contained.
const BUSY = Object.freeze({
  id: 'Server sedang sibuk memeriksa kata sandi. Coba lagi sebentar lagi.',
  en: 'The server is busy checking passwords. Try again in a moment.',
});
/** 503 + Retry-After for an attempt refused unchecked; returns the notice text for the page. */
function busy(req: Request, res: Response): string {
  res.status(503).set('Retry-After', '1');
  return BUSY[req.lang] ?? BUSY.id;
}

export interface PlatformAuth {
  readonly service: AuthService;
  readonly publicRouter: Router;
  readonly gate: RequestHandler;
  readonly accountRouter: Router;
  /**
   * An ACCOUNT form of this browser, posted from one of our pages: same Origin, same-origin Sec-Fetch-Site, and the
   * token bound to hvwa_sid AND the sign-in (hvwa_auth). Every state-changing platform form after the gate uses it.
   */
  formOk(req: Request): boolean;
  /** The account-form token for a form another router renders. */
  csrfFor(req: Request): string;
  /** The 403 "request refused" page for a failed formOk. */
  refuse(req: Request, res: Response, back: string): Promise<void>;
}

/** The login for one app over its platform DB (creates the admin account on first use). */
export function platformAuth(db: DatabaseSync, opts: AuthOptions = {}): PlatformAuth {
  const service = createAuthService(db, opts);
  const cookies = cookieAttributes(opts.secureCookies === true);
  // The login page links to /register only when registration is mounted and open (read once: an env switch).
  const registerLink = opts.registration !== undefined && opts.registration.open !== false;

  const refuse = async (req: Request, res: Response, back: string) => {
    noStore(res);
    res.locals.platformAuth ??= { signedIn: false }; // /login is before the gate
    res.status(403);
    await sendPage(res, view('refused'), { pageTitle: res.locals.t('auth.csrf_heading'), back });
  };
  /**
   * A form post is ours: same Origin, same-origin Sec-Fetch-Site, and the synchroniser token. The login form's
   * token is bound to hvwa_sid; an account form's (`account`) to hvwa_sid and the sign-in (hvwa_auth). The Origin
   * must carry the public scheme when one is configured (portal mode behind the tunnel).
   */
  const formOk = (req: Request, account: boolean) => originOk(req, opts.publicScheme ?? req.protocol) && fetchSiteOk(req) &&
    service.checkCsrf(req.sessionId, field(req, '_csrf'), account ? authTokenOf(req) : undefined);

  const renderLogin = (req: Request, res: Response, next: string, failed: boolean, notice?: string) => {
    noStore(res);
    res.locals.platformAuth = { signedIn: false };
    return sendPage(res, view('login'), {
      pageTitle: res.locals.t('auth.login_heading'), csrf: service.csrfToken(req.sessionId), next, failed, notice,
      registered: req.query.registered === '1', registerLink,
    });
  };

  const publicRouter = Router();
  publicRouter.get('/login', async (req, res) => {
    const next = safeNext(req.query.next);
    if (service.session(req.cookies?.[AUTH_COOKIE])) { noStore(res); res.redirect(303, next); return; }
    await renderLogin(req, res, next, false);
  });
  const perIp = opts.signInPerIp;
  const ipFailures = perIp ? windowLimiter({ max: perIp.max, windowMs: perIp.windowMs, now: opts.now }) : undefined;
  publicRouter.post('/login', async (req, res) => {
    if (!formOk(req, false)) { await refuse(req, res, '/login'); return; }
    const next = safeNext(field(req, 'next'));
    const ip = clientIp(req);
    if (ipFailures && perIp && ipFailures.count(ip) >= perIp.max) {
      res.status(429).set('Retry-After', String(Math.ceil(perIp.windowMs / 1000)));
      await renderLogin(req, res, next, false, res.locals.t('auth.login_limited'));
      return;
    }
    const result = await service.signIn(field(req, 'username'), field(req, 'password'));
    if (!result.ok) {
      if (result.busy) { await renderLogin(req, res, next, false, busy(req, res)); return; }
      ipFailures?.allow(ip); // one failure spent from this IP's budget
      res.status(401);
      await renderLogin(req, res, next, true);
      return;
    }
    service.revoke(req.cookies?.[AUTH_COOKIE]); // a fresh token per sign-in; the old one dies
    noStore(res);
    res.cookie(AUTH_COOKIE, result.token, cookies.set);
    res.redirect(303, next);
  });
  if (opts.registration) {
    publicRouter.use(registrationRouter({
      service, options: opts.registration, view: view('register'),
      loginFormOk: (req) => formOk(req, false), refuse,
      signedIn: (req) => service.session(req.cookies?.[AUTH_COOKIE]) !== undefined,
    }));
  }

  const gate: RequestHandler = (req, res, next) => {
    const presented: unknown = req.cookies?.[AUTH_COOKIE];
    const session = service.session(presented);
    if (session) {
      res.locals.platformAuth = {
        signedIn: true, userId: session.userId, user: session.username, role: session.role,
        defaultPassword: session.defaultPassword,
        csrf: service.csrfToken(req.sessionId, authTokenOf(req)), // the layout's logout form: an account form
      };
      next();
      return;
    }
    if (presented !== undefined) res.clearCookie(AUTH_COOKIE, cookies.clear); // stale, revoked or forged
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
    if (!formOk(req, true)) { await refuse(req, res, '/'); return; }
    service.revoke(req.cookies?.[AUTH_COOKIE]);
    noStore(res);
    res.clearCookie(AUTH_COOKIE, cookies.clear);
    res.redirect(303, '/login');
  });

  const renderPassword = (req: Request, res: Response, data: { error?: string; changed?: boolean; notice?: string }) => {
    noStore(res);
    return sendPage(res, view('password'), {
      pageTitle: res.locals.t('auth.pw_heading'), csrf: service.csrfToken(req.sessionId, authTokenOf(req)),
      user: res.locals.platformAuth?.user ?? '', error: data.error, changed: data.changed === true, notice: data.notice,
      pwMin: service.passwordMinLength,
    });
  };
  accountRouter.get('/account/password', async (req, res) => {
    await renderPassword(req, res, { changed: req.query.changed === '1' });
  });
  accountRouter.post('/account/password', async (req, res) => {
    if (!formOk(req, true)) { await refuse(req, res, '/account/password'); return; }
    const username = res.locals.platformAuth?.user ?? '';
    const result = await service.changePassword(username, field(req, 'current'), field(req, 'password'), field(req, 'confirm'));
    if (!result.ok) {
      if (result.error === 'busy') { await renderPassword(req, res, { notice: busy(req, res) }); return; }
      res.status(400);
      await renderPassword(req, res, { error: result.error });
      return;
    }
    noStore(res);
    res.cookie(AUTH_COOKIE, result.token, cookies.set); // every other token is gone; this browser stays signed in
    res.redirect(303, '/account/password?changed=1');
  });

  return Object.freeze({
    service, publicRouter, gate, accountRouter,
    formOk: (req: Request) => formOk(req, true),
    csrfFor: (req: Request) => service.csrfToken(req.sessionId, authTokenOf(req)),
    refuse,
  });
}
