// _shared/lab.ts — plumbing shared by the Gatekeeper labs (login-style labs with citadel_admin and pilgrim).
// Not a challenge: nothing here is served by View Source. Limiter and lockout LOGIC stays in each
// challenge's levels/*.ts, where the flaw (and its Diff) must be visible.
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { field, labPath } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import type { Challenge } from '../../../core/registry.js';

/** The lab's message: ok selects the success/error style. */
export interface Result { readonly ok: boolean; readonly text: string }

export interface Account { readonly username: string; readonly password: string; readonly role: 'admin' | 'user' }

/** Failed-attempt bookkeeping for one lockout key. */
export interface Counter { failures: number; lockedUntil: number }

/** The player's own (unprivileged) account, shown on the lab page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });
export const ADMIN_NAME = 'citadel_admin';

/** Both accounts of a login lab, the admin with the given password. */
export function accountsFor(adminPassword: string): readonly Account[] {
  return [
    { username: ADMIN_NAME, password: adminPassword, role: 'admin' },
    { username: PLAYER.username, password: PLAYER.password, role: 'user' },
  ];
}

/**
 * The message for someone who is signed in: only the admin holds the flag, and Divine never issues one.
 * Call it OUTSIDE tryDb (flagFor throws at Divine by design).
 */
export function welcome(
  req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>,
  who: { readonly username: string; readonly role: string },
): Result {
  const hello = `Welcome, ${who.username} (role: ${who.role}).`;
  if (who.role !== 'admin') return { ok: true, text: `${hello} Only the citadel admin holds the flag.` };
  if (req.level === 'divine') return { ok: true, text: hello };
  return { ok: true, text: `${hello} Flag: ${flagFor(req, challenge)}` };
}

/** The player's credentials check, shared by the pilgrim sign-in forms (GK-12 ... GK-18). Reads the username/password fields. */
export function pilgrimLogin(req: Request): { readonly ok: boolean; readonly result: Result; readonly username: string; readonly password: string } {
  const username = field(req, 'username');
  const password = field(req, 'password');
  const ok = username === PLAYER.username && password === PLAYER.password;
  return { ok, username, password, result: ok ? { ok: true, text: `Signed in as ${PLAYER.username}.` } : { ok: false, text: 'Invalid username or password.' } };
}

/**
 * The flag line of an admin page: the flag below Divine, a plain welcome at Divine (Divine never issues a flag).
 * It is for a caller the lab's REAL access check let in; `sendAdminPage` calls it when given `flag`.
 */
export function flagLine(req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>): string {
  return req.level === 'divine' ? 'Welcome back.' : `Flag: ${flagFor(req, challenge)}`;
}

/** What `sendAdminPage` shows. */
export interface AdminPage {
  /** Whether the caller got in. The page answers 403 when not. */
  readonly admin: boolean;
  /** The success message. */
  readonly granted: string;
  /**
   * Show the flag line after `granted` (only when `admin` is true: the caller got in). The page decides
   * Divine's rule itself: "Welcome back." instead of a flag, whatever the lab passes.
   */
  readonly flag?: { readonly req: Pick<Request, 'sessionId' | 'level'>; readonly challenge: Pick<Challenge, 'id' | 'levels'> };
  /** The denial message. */
  readonly denial: string;
  /** Optional preformatted content shown to the admin only (an export). */
  readonly pre?: string;
  /** The status of the denial (default 403). */
  readonly denyStatus?: number;
}

const adminView = fileURLToPath(new URL('./views/admin.ejs', import.meta.url));

/** Render the shared admin page: 200 with `granted` for the admin, 403 (or `denyStatus`) with `denial` for everyone else. */
export async function sendAdminPage(res: Response, o: AdminPage): Promise<void> {
  res.status(o.admin ? 200 : (o.denyStatus ?? 403));
  const granted = o.admin && o.flag ? `${o.granted} ${flagLine(o.flag.req, o.flag.challenge)}`.trim() : o.granted;
  await sendPage(res, adminView, { base: labPath(res), admin: o.admin, granted, denial: o.denial, pre: o.admin ? (o.pre ?? '') : '' });
}

/** A curl example a player can actually use: the data `_shared/views/curl-note.ejs` renders. */
export interface CurlView {
  readonly url: string;
  /** '' for the default (GET, or POST when there is a body), else e.g. 'PUT'. */
  readonly method: string;
  readonly headers: readonly string[];
  readonly cookies: readonly string[];
  readonly data: string;
  /** Form fields, each already shell-quoted: `--data-urlencode '<field>'`. */
  readonly form: readonly string[];
}

export interface CurlSpec {
  /** Path below the lab, e.g. '/vault'. */
  readonly path: string;
  /** Extra headers, "Name: value" (use <placeholders>). */
  readonly headers?: readonly string[];
  /** Extra cookies besides the platform session, "name=value" (use <placeholders>). */
  readonly cookies?: readonly string[];
  /** An HTTP method for `-X` (PUT, PATCH, DELETE ...); omit for GET, or for a POST that has a body. */
  readonly method?: string;
  /** A request body (JSON), shown after `-d` in single quotes. */
  readonly data?: string;
  /** Form fields, sent with `--data-urlencode 'name=value'` (curl encodes them). */
  readonly form?: Readonly<Record<string, string>>;
}

/** Text for inside single quotes in a shell line: each `'` closes the quote, adds an escaped quote and reopens. */
export function shellQuote(text: string): string {
  return text.replace(/'/g, "'\\''");
}

/**
 * The curl example for a lab page. It always carries the FULL quoted URL (origin + canonical lab path + the served
 * level) and a `-b` for the platform session cookie with a placeholder: a lab belongs to the browser session, and curl
 * without it starts another session whose state and flags the browser cannot submit. Never prints the real session id.
 */
export function curlFor(req: Request, res: Response, spec: CurlSpec): CurlView {
  const origin = `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`;
  return {
    url: `${origin}${labPath(res)}${spec.path}?level=${req.level}`,
    method: spec.method ?? '', headers: spec.headers ?? [], cookies: spec.cookies ?? [],
    data: shellQuote(spec.data ?? ''), form: Object.entries(spec.form ?? {}).map(([k, v]) => shellQuote(`${k}=${v}`)),
  };
}
