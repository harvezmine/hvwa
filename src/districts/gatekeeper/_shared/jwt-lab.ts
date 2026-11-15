// _shared/jwt-lab.ts — the common shell of the JWT labs (GK-04 … GK-07): sign-in, the token cookie, the vault.
// Plumbing only. Every verification policy (and every lab-specific route: public.pem, robots.txt, wordlist ...)
// stays in each challenge's levels/*.ts and challenge.ts, where View Source and the Diff show the flaw.
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import { field, header, labPath } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { sendPage } from '../../../core/render.js';
import type { Challenge } from '../../../core/registry.js';
import { PLAYER, curlFor, welcome, type Result } from './lab.js';

export type Claims = Record<string, unknown>;

/** What a level's verify answers: the claims it accepts, or why it refused (shown below Divine only). */
export type Verdict = { readonly ok: true; readonly claims: Claims } | { readonly ok: false; readonly reason: string };

/** The lab's token cookie. One name per level: levels share a path and must not overwrite each other. */
export function cookieName(level: Level): string {
  return `citadel_jwt_${level}`;
}

const portalView = fileURLToPath(new URL('./views/jwt-portal.ejs', import.meta.url));
const vaultView = fileURLToPath(new URL('./views/jwt-vault.ejs', import.meta.url));

/** The lab cookie's value, if it is a string. */
function cookieOf(req: Request): string | undefined {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[cookieName(req.level)];
  return typeof v === 'string' ? v : undefined;
}

/** The presented token: `Authorization: Bearer <jwt>` first (when a header is sent the cookie is not consulted), else the lab cookie. */
export function presented(req: Request): string | undefined {
  const auth = header(req, 'authorization');
  if (auth !== undefined) return /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
  return cookieOf(req);
}

export interface JwtPortal {
  /** The registered challenge (a thunk: mount runs after register()). */
  readonly challenge: () => Pick<Challenge, 'id' | 'levels'>;
  /** One or two sentences about this lab, shown on the sign-in page. */
  readonly blurb: string;
  /** Lab-specific files to link (the absolute lab path and `?level=` are added). */
  readonly links?: readonly { readonly path: string; readonly text: string }[];
  /** A genuine token for `pilgrim` (role user), signed the way this lab's server signs. */
  readonly issue: (req: Request) => string;
  /** The lab's verification policy at `req.level` (hand-rolled in levels/*.ts). */
  readonly verify: (req: Request, token: string) => Verdict;
  /** A sample token to show on the page (GK-07's cracking target). */
  readonly sample?: (req: Request) => string;
}

/** Mount GET `/`, POST `/` (sign-in) and GET `/vault` on a lab router. */
export function mountJwtPortal(router: Router, o: JwtPortal): void {
  const page = (req: Request, res: Response, token: string, result: Result | null, username: string, password: string) => {
    const base = labPath(res);
    return {
      base, curl: curlFor(req, res, { path: '/vault', headers: ['Authorization: Bearer <token>'] }), cookie: cookieName(req.level), account: PLAYER,
      blurb: o.blurb, links: (o.links ?? []).map((l) => ({ text: l.text, href: `${base}${l.path}?level=${req.level}` })),
      sample: o.sample?.(req) ?? '', token, result, username, password,
    };
  };

  router.get('/', async (req, res) => {
    await sendPage(res, portalView, page(req, res, cookieOf(req) ?? '', null, '', ''));
  });

  router.post('/', async (req, res) => {
    const username = field(req, 'username');
    const password = field(req, 'password');
    let result: Result;
    let token = cookieOf(req) ?? '';
    if (username === PLAYER.username && password === PLAYER.password) {
      token = o.issue(req);
      // Not HttpOnly on purpose: the player is meant to edit it (the page says how).
      res.cookie(cookieName(req.level), token, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
      result = { ok: true, text: `Signed in as ${PLAYER.username}. Token issued.` };
    } else {
      result = { ok: false, text: 'Invalid username or password.' };
    }
    await sendPage(res, portalView, page(req, res, token, result, username, password));
  });

  router.get('/vault', async (req, res) => {
    const token = presented(req);
    let result: Result;
    if (token === undefined || token === '') {
      result = { ok: false, text: 'Missing token. Sign in first, then send it as a Bearer header or the lab cookie.' };
    } else {
      const verdict = o.verify(req, token);
      if (!verdict.ok) {
        // Below Divine the reason is shown on purpose (CWE-209); Divine only says it was refused.
        result = { ok: false, text: req.level === 'divine' ? 'Invalid token.' : `Invalid token: ${verdict.reason}.` };
      } else {
        const { sub, role } = verdict.claims;
        // The flag needs a VERIFIED role "admin"; Divine never issues one (welcome() enforces it).
        result = welcome(req, o.challenge(), { username: typeof sub === 'string' ? sub : 'unknown', role: typeof role === 'string' ? role : 'unknown' });
      }
    }
    await sendPage(res, vaultView, { base: labPath(res), result });
  });
}
