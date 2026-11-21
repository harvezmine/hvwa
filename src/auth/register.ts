// src/auth/register.ts — open self-registration (portal mode, spec range §4 and §16): GET/POST /register. PLATFORM code.
// Order of checks: the login form's guards (Origin, Sec-Fetch-Site, the token bound to hvwa_sid); registration open
// (HVWA_REGISTRATION_OPEN, read once at start: the `open` option); the service's username and password rules; then at
// most `perIp` accounts per client IP (clientIp: CF-Connecting-IP, else the socket) per `windowMs`, asked right before
// the hash, so a typo never spends it. Compact POC (plan amendment): no event code and no admin switch.
import { Router, type Request, type Response } from 'express';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { clientIp } from './client-ip.js';
import { noStore } from './forms.js';
import { windowLimiter } from './rate-limit.js';
import type { AuthService, RegisterError } from './service.js';

export interface RegistrationOptions {
  /** HVWA_REGISTRATION_OPEN (src/range/config.ts `registrationOpen`): false closes /register. Default true. */
  readonly open?: boolean;
  /** Accounts per client IP per window. Default 5 (spec §4). */
  readonly perIp?: number;
  /** Default one hour. */
  readonly windowMs?: number;
  /** Clock for the limit; tests inject one. */
  readonly now?: () => number;
}

export const REGISTRATION_DEFAULTS = Object.freeze({ perIp: 5, windowMs: 60 * 60_000 });

export interface RegistrationDeps {
  readonly service: AuthService;
  readonly options: RegistrationOptions;
  /** Absolute path of register.ejs. */
  readonly view: string;
  /** The login form's guard (Origin, Sec-Fetch-Site, the token bound to hvwa_sid). */
  readonly loginFormOk: (req: Request) => boolean;
  readonly refuse: (req: Request, res: Response, back: string) => Promise<void>;
  readonly signedIn: (req: Request) => boolean;
}

export function registrationRouter(deps: RegistrationDeps): Router {
  const { service, options } = deps;
  const open = options.open !== false;
  const windowMs = options.windowMs ?? REGISTRATION_DEFAULTS.windowMs;
  const limiter = windowLimiter({ max: options.perIp ?? REGISTRATION_DEFAULTS.perIp, windowMs, now: options.now });

  const render = (req: Request, res: Response, data: { error?: RegisterError; username?: string; limited?: boolean } = {}) => {
    noStore(res);
    res.locals.platformAuth ??= { signedIn: false }; // /register is before the gate
    return sendPage(res, deps.view, {
      pageTitle: res.locals.t('auth.register_heading'), csrf: service.csrfToken(req.sessionId),
      pwMin: service.passwordMinLength, closed: !open, limited: data.limited === true,
      error: data.error, username: data.username ?? '',
    });
  };

  const r = Router();
  r.get('/register', async (req, res) => {
    if (deps.signedIn(req)) { noStore(res); res.redirect(303, '/'); return; }
    if (!open) res.status(403);
    await render(req, res);
  });
  r.post('/register', async (req, res) => {
    if (!deps.loginFormOk(req)) { await deps.refuse(req, res, '/register'); return; }
    if (!open) { res.status(403); await render(req, res); return; }
    const username = field(req, 'username');
    const ip = clientIp(req);
    const result = await service.register(username, field(req, 'password'), field(req, 'confirm'), () => limiter.allow(ip));
    if (result.ok) { noStore(res); res.redirect(303, '/login?registered=1'); return; }
    if (result.error === 'limited') {
      res.status(429).set('Retry-After', String(Math.ceil(windowMs / 1000)));
      await render(req, res, { limited: true, username });
      return;
    }
    res.status(result.error === 'busy' ? 503 : 400);
    if (result.error === 'busy') res.set('Retry-After', '1');
    await render(req, res, { error: result.error, username });
  });
  return r;
}
