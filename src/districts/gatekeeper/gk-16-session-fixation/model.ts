// model.ts — GK-16's lab state, the portal pages both browsers open, and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts. The level modules are gathered here (not in challenge.ts) because
// the admin's simulated browser needs them too; they import only types from this file, so there is no import cycle.
import { byLevel, field, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import type { Text } from '../../../core/registry.js';
import { CITADEL_ORIGIN, simWorld, type SimBrowser, type SimRequest, type SimResponse, type SimWorld } from '../../../core/sim.js';
import { newId, trimBounded } from '../../_shared/collections.js';
import { ADMIN_NAME, PLAYER } from '../_shared/lab.js';
import { cookiePath, toSim, type Reply, type TwinCookie } from '../_shared/twin.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** The portal's session cookie. One name per level: levels share the lab path and must not overwrite each other. */
export const cookieName = (level: Level): string => `portal_sid_${level}`;

/** One portal session: who signed in on it (null: nobody yet). */
export interface Session { user: string | null }

/** One player's lab at one level. */
export interface LabState {
  /** The player's attacker log, the victim's visits and the clock (`world.now`, a test seam). */
  readonly world: SimWorld;
  /** The admin's browser: it opens the link you send and signs in on the sign-in page it lands on. */
  readonly admin: SimBrowser;
  readonly adminPassword: string;
  /** Session id -> session. Bounded (oldest anonymous ones go first). */
  readonly sessions: Map<string, Session>;
  /** Inquisitor's grace period: an old id -> the session it now stands for, until when (ms). Bounded. */
  readonly aliases: Map<string, { readonly to: string; readonly until: number }>;
  /** Inquisitor's resume links: token -> session id. Bounded. */
  readonly resumes: Map<string, string>;
  /** Open a new session under a fresh random id (32 hex) for `user` (null: nobody yet). Returns the id. */
  openSession(user: string | null): string;
}

/** What every levels/<level>.ts exports. */
export interface FixationLevel {
  /** The session id a page's URL asks for (`?sid=`), when this level honours one; undefined to ignore the URL. */
  sidFromUrl(state: LabState, query: URLSearchParams): string | undefined;
  /** `user` signs in on the browser's session `sid` (always a known one). Returns the id the browser keeps. */
  signIn(state: LabState, sid: string, user: string, nowMs: number): string;
  /** Who is signed in on session id `sid` now; undefined for nobody or an unknown id. */
  whoIs(state: LabState, sid: string, nowMs: number): string | undefined;
  /** A link (citadel path and query) that continues session `sid` in another browser, or undefined for none. */
  shareLink(state: LabState, sid: string): string | undefined;
  /** The session a `/resume?token=` link sets, or undefined (an unknown token, or no resume links at this level). */
  resume(state: LabState, token: string): string | undefined;
}

export const impl = byLevel<FixationLevel>({ acolyte, templar, inquisitor, divine });

const MAX_ENTRIES = 100;

/** Platform safety, not the lesson: anonymous sessions go before signed-in ones; aliases and resume links oldest first. */
function bound(state: LabState): void {
  trimBounded(state.sessions, { max: MAX_ENTRIES, spare: (_id, s) => s.user !== null });
  trimBounded(state.aliases, { max: MAX_ENTRIES });
  trimBounded(state.resumes, { max: MAX_ENTRIES });
}

/** What a portal page needs from a browser's request. `base`: labPath(res) for real routes, '' on the citadel. */
export interface Visit {
  readonly level: Level;
  readonly query: URLSearchParams;
  /** The portal cookie the request carried. */
  readonly cookie: string | undefined;
  readonly base: string;
}

/** A portal page: the Reply, plus what the page shows about the browser's session. */
export interface Portal extends Reply {
  readonly ok: boolean;
  readonly sid: string;
  readonly who: string | undefined;
  /** The level's link to continue this session elsewhere, as a citadel URL. */
  readonly share: string | undefined;
}

const cookieFor = (v: Visit, sid: string): TwinCookie => ({ name: cookieName(v.level), value: sid, path: cookiePath(v.base) });

/** The session the browser is on: an id from the URL if the level adopts it, else its cookie if known, else a new one. */
function sessionOf(v: Visit, state: LabState): { sid: string; cookies: TwinCookie[] } {
  const level = impl.for(v.level);
  const fromUrl = level.sidFromUrl(state, v.query);
  if (fromUrl !== undefined) return { sid: fromUrl, cookies: fromUrl === v.cookie ? [] : [cookieFor(v, fromUrl)] };
  const c = v.cookie;
  if (c !== undefined && (state.sessions.has(c) || level.whoIs(state, c, state.world.now()) !== undefined)) return { sid: c, cookies: [] };
  const sid = state.openSession(null);
  return { sid, cookies: [cookieFor(v, sid)] };
}

function portal(v: Visit, state: LabState, sid: string, cookies: TwinCookie[], ok: boolean, text: string): Portal {
  const level = impl.for(v.level);
  const share = level.shareLink(state, sid);
  const who = level.whoIs(state, sid, state.world.now());
  bound(state);
  return { status: 200, cookies, ok, text, sid, who, share: share === undefined ? undefined : `${CITADEL_ORIGIN}${share}` };
}

/** GET /: the sign-in page. */
export function portalHome(v: Visit, state: LabState): Portal {
  const { sid, cookies } = sessionOf(v, state);
  return portal(v, state, sid, cookies, true, '');
}

/** POST /: sign in on the browser's session (the level decides whether the id changes). */
export function portalSignIn(v: Visit, state: LabState, username: string, password: string): Portal {
  const { sid, cookies } = sessionOf(v, state);
  const user = username === ADMIN_NAME && password === state.adminPassword ? ADMIN_NAME
    : username === PLAYER.username && password === PLAYER.password ? PLAYER.username : undefined;
  if (user === undefined) return portal(v, state, sid, cookies, false, 'Invalid username or password.');
  const next = impl.for(v.level).signIn(state, sid, user, state.world.now());
  return portal(v, state, next, next === sid ? cookies : [cookieFor(v, next)], true, `Signed in as ${user}.`);
}

/** GET /resume?token=: set the session a resume link names, then on to the sign-in page. */
export function portalResume(v: Visit, state: LabState): Reply {
  const sid = impl.for(v.level).resume(state, v.query.get('token') ?? '');
  if (sid === undefined) return { status: 404, text: 'This link is not valid.' };
  return { status: 302, location: `${v.base}/`, cookies: [cookieFor(v, sid)], text: '' };
}

/** Who the browser's portal cookie is signed in as (GET /admin). Never creates a session. */
export function portalWho(v: Visit, state: LabState): string | undefined {
  return v.cookie === undefined ? undefined : impl.for(v.level).whoIs(state, v.cookie, state.world.now());
}

/** How the citadel's sign-in page starts, as the admin's browser sees it. */
export const SIGN_IN_PAGE = 'Citadel portal — Sign in';

/** The lab as the admin's browser sees it at http://citadel.test: the twins of the real routes, from the same functions. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const v: Visit = { level, query: r.query, cookie: r.cookies[cookieName(level)], base: '' };
  if (r.path === '/') {
    const p = r.method === 'POST' ? portalSignIn(v, state, field(r, 'username'), field(r, 'password')) : portalHome(v, state);
    return toSim({ ...p, text: p.text === '' ? SIGN_IN_PAGE : `${SIGN_IN_PAGE}\n${p.text}` });
  }
  if (r.path === '/resume') return toSim(portalResume(v, state));
  if (r.path === '/admin') {
    return portalWho(v, state) === ADMIN_NAME ? { status: 200, body: 'Citadel admin console.' } : { status: 403, body: 'Admin only.' };
  }
  return { status: 404, body: 'Not found' };
}

const NOT_SIGN_IN: Text = Object.freeze({
  id: 'Peramban admin berakhir di halaman yang bukan halaman masuk citadel, jadi admin tidak masuk.',
  en: 'The admin\'s browser ended on a page that is not the citadel sign-in page, so the admin did not sign in.',
});
const SIGNED_IN: Text = Object.freeze({ id: 'Admin masuk di halaman yang dibuka tautan Anda.', en: 'The admin signed in on the page your link opened.' });
const NOT_SIGNED_IN: Text = Object.freeze({ id: 'Admin mencoba masuk, tetapi gagal.', en: 'The admin tried to sign in, but it did not work.' });

/** The admin's standing state: a fresh browser with no citadel cookies (each action starts there). Never browses. */
export function rearm(state: LabState): void {
  state.admin.cookies.clear();
}

/**
 * The scripted admin: opens `url`; if it ends on the citadel sign-in page, signs in there (the form posts back to the
 * page's own URL, as a form with no action does). Returns the note for the panel.
 */
export function adminOpens(state: LabState, url: string): Text {
  rearm(state);
  const visit = state.admin.follow(url);
  const page = visit.page;
  if (visit.outcome !== 'page' || page === undefined || page.status !== 200 || !page.body.startsWith(SIGN_IN_PAGE)) return NOT_SIGN_IN;
  const after = state.admin.submit(page.url, { username: ADMIN_NAME, password: state.adminPassword }, { referrer: page.url });
  return after.page?.body.includes(`Signed in as ${ADMIN_NAME}.`) === true ? SIGNED_IN : NOT_SIGNED_IN;
}

// Per player AND per level: the sessions, the admin's browser and the attacker log together, so one eviction (or
// TTL expiry) drops them all at once. No limiter lives here, so the shared sim budget is harmless.
const labs = perSession((level: Level): LabState => {
  const world = simWorld();
  const sessions = new Map<string, Session>();
  // The handler reads `state` only when the admin browses, after it is assigned.
  const state: LabState = {
    world,
    admin: world.browser((r) => citadel(level, state, r)),
    adminPassword: newId(),
    sessions,
    aliases: new Map(),
    resumes: new Map(),
    openSession(user: string | null): string {
      const id = newId();
      sessions.set(id, { user });
      return id;
    },
  };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.adminPassword`, `.admin.cookies`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
