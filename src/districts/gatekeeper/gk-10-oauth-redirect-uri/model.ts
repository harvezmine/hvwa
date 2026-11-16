// model.ts — GK-10's lab state: the identity provider "Pilgrim-ID" and its client "Citadel", the pages both browsers
// open, and the contract every levels/<level>.ts implements. Not served: View Source shows only levels/*.ts. The level
// modules are gathered here because the admin's simulated browser needs them too; they import only types from this
// file, so there is no import cycle.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { CITADEL_ORIGIN, simWorld, type SimBrowser, type SimRequest, type SimResponse, type SimWorld } from '../../../core/sim.js';
import { ADMIN_NAME, PLAYER } from '../_shared/lab.js';
import {
  CLIENT_ID, newId, newVerifier, putBounded, s256, withParams, type Exchange, type IssuedCode,
} from '../_shared/oauth.js';
import { cookiePath, toSim, type Reply, type TwinCookie } from '../_shared/twin.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

export type { Exchange, IssuedCode };

/** Citadel's registration at Pilgrim-ID: client CLIENT_ID with this one redirect URI. */
export const REGISTERED_REDIRECT = `${CITADEL_ORIGIN}/callback`;

/** One cookie name per level (levels share the lab path). */
export const pidCookie = (level: Level): string => `pid_session_${level}`;
export const clientCookie = (level: Level): string => `citadel_session_${level}`;
/** Where Citadel goes after a sign-in: the id of the `next` the sign-in started with (kept on the server, 10 minutes). */
export const nextCookie = (level: Level): string => `citadel_next_${level}`;
/** Divine: the sign-in this browser started (its state and PKCE verifier stay on the server). */
export const loginCookie = (level: Level): string => `citadel_login_${level}`;

/** What every levels/<level>.ts exports. */
export interface RedirectLevel {
  /** Pilgrim-ID, /idp/authorize: may a code for client citadel be sent to this redirect_uri? */
  allowRedirect(redirectUri: string): boolean;
  /** Pilgrim-ID, /idp/authorize: refuse a request for lack of a PKCE challenge (an error text), or accept (undefined). */
  checkPkce(challenge: string | undefined, method: string | undefined): string | undefined;
  /** Pilgrim-ID token endpoint: does `exchange` redeem `issued` (undefined: no such code)? A level may use it up here. */
  redeem(issued: IssuedCode | undefined, exchange: Exchange, nowMs: number): boolean;
  /** Citadel, /login: does the sign-in use PKCE (a verifier kept on the server, its S256 challenge sent)? */
  readonly pkce: boolean;
  /** Citadel, /callback: where the signed-in page moves the browser on to by itself, and the page's Referrer-Policy. */
  landing(next: string | undefined): { readonly forward?: string; readonly referrerPolicy?: string };
}

export const impl = byLevel<RedirectLevel>({ acolyte, templar, inquisitor, divine });

/** One player's lab at one level. */
export interface LabState {
  /** The attacker log, the victim's visits and the clock (`world.now`, a test seam). */
  readonly world: SimWorld;
  /** The admin's browser, signed in to Pilgrim-ID (re-armed before every action). */
  readonly admin: SimBrowser;
  readonly adminPassword: string;
  /** The admin's Pilgrim-ID session id: pinned, never pushed out. */
  readonly adminPid: string;
  /** Pilgrim-ID sessions: id -> user. Bounded. */
  readonly idpSessions: Map<string, string>;
  /** Citadel sessions: id -> user. Bounded. */
  readonly clientSessions: Map<string, string>;
  /** Divine's pending sign-ins: login id -> state and verifier. Bounded. */
  readonly logins: Map<string, { readonly state: string; readonly verifier: string }>;
  /** Authorization codes: code -> what it was issued for. Bounded. */
  readonly codes: Map<string, IssuedCode>;
  /** Where sign-ins return to: id (the next cookie) -> the `next` and until when it holds (world clock). Bounded. */
  readonly returns: Map<string, { readonly next: string; readonly until: number }>;
}

const MAX_ENTRIES = 50;
const CODE_TTL_MS = 10 * 60 * 1000;
/** A sign-in's `next` lasts as long as a sign-in may take: a stale one never moves a later sign-in on. */
const RETURN_TTL_MS = 10 * 60 * 1000;
const put = <V>(m: Map<string, V>, key: string, value: V, keep?: (k: string) => boolean): void => putBounded(m, key, value, MAX_ENTRIES, keep);

/** What a page needs from a browser's request. `base`: labPath(res) for real routes, '' on the citadel. */
export interface Visit {
  readonly level: Level;
  readonly query: URLSearchParams;
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly base: string;
}

const accountOf = (state: LabState, username: string, password: string): string | undefined =>
  username === ADMIN_NAME && password === state.adminPassword ? ADMIN_NAME
    : username === PLAYER.username && password === PLAYER.password ? PLAYER.username : undefined;

/** Who this browser is signed in as at Pilgrim-ID and at Citadel. */
export function whoIs(v: Visit, state: LabState): { readonly idp?: string; readonly client?: string } {
  return { idp: state.idpSessions.get(v.cookies[pidCookie(v.level)] ?? ''), client: state.clientSessions.get(v.cookies[clientCookie(v.level)] ?? '') };
}

/** POST / (the player's browser only): sign in to Pilgrim-ID. */
export function idpSignIn(v: Visit, state: LabState, username: string, password: string): Reply & { readonly ok: boolean } {
  const user = accountOf(state, username, password);
  if (user === undefined) return { status: 200, ok: false, text: 'Invalid username or password.' };
  const sid = newId();
  put(state.idpSessions, sid, user, (k) => k === state.adminPid);
  return { status: 200, ok: true, text: `Signed in to Pilgrim-ID as ${user}.`, cookies: [{ name: pidCookie(v.level), value: sid, path: cookiePath(v.base) }] };
}

/** GET /login (Citadel): start "Sign in with Pilgrim-ID", remembering where to go afterwards. */
export function startLogin(v: Visit, state: LabState): Reply {
  const level = impl.for(v.level);
  const path = cookiePath(v.base);
  const next = v.query.get('next');
  const cookies: TwinCookie[] = [{ name: nextCookie(v.level), value: '', path, clear: true }];
  if (next) {
    const id = newId();
    put(state.returns, id, { next, until: state.world.now() + RETURN_TTL_MS });
    cookies[0] = { name: nextCookie(v.level), value: id, path, maxAgeSec: RETURN_TTL_MS / 1000 };
  }
  const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REGISTERED_REDIRECT });
  if (level.pkce) {
    const login = newId();
    const pending = { state: newId(), verifier: newVerifier() };
    put(state.logins, login, pending);
    params.set('state', pending.state);
    params.set('code_challenge', s256(pending.verifier));
    params.set('code_challenge_method', 'S256');
    cookies.push({ name: loginCookie(v.level), value: login, path });
  }
  return { status: 302, location: `${v.base}/idp/authorize?${params.toString()}`, cookies, text: '' };
}

/** GET /idp/authorize (Pilgrim-ID): a signed-in user's code goes to the redirect_uri, if the level lets it. */
export function authorize(v: Visit, state: LabState): Reply {
  const level = impl.for(v.level);
  const user = whoIs(v, state).idp;
  if (user === undefined) return { status: 200, text: 'Pilgrim-ID: sign in first, then open this link again.' };
  if (v.query.get('client_id') !== CLIENT_ID) return { status: 400, text: 'Pilgrim-ID: unknown client.' };
  if (v.query.get('response_type') !== 'code') return { status: 400, text: 'Pilgrim-ID: unsupported response_type.' };
  const redirectUri = v.query.get('redirect_uri') ?? '';
  if (redirectUri === '' || !level.allowRedirect(redirectUri)) {
    return { status: 400, text: 'Pilgrim-ID: this redirect_uri is not registered for the client.' };
  }
  const challenge = v.query.get('code_challenge') ?? undefined;
  const pkceError = level.checkPkce(challenge, v.query.get('code_challenge_method') ?? undefined);
  if (pkceError !== undefined) return { status: 400, text: `Pilgrim-ID: ${pkceError}` };
  const code = newId();
  put(state.codes, code, {
    user, clientId: CLIENT_ID, redirectUri, ...(challenge === undefined ? {} : { challenge }),
    expiresAt: state.world.now() + CODE_TTL_MS, used: false,
  });
  const st = v.query.get('state');
  return { status: 302, location: withParams(redirectUri, { code, ...(st === null ? {} : { state: st }) }), text: '' };
}

export const SIGN_IN_FAILED = 'Sign-in failed';

/** GET /callback (Citadel): redeem the code at Pilgrim-ID (in process) and sign the browser in to Citadel. */
export function callback(v: Visit, state: LabState): Reply & { readonly user?: string } {
  const level = impl.for(v.level);
  const path = cookiePath(v.base);
  const cookies: TwinCookie[] = [];
  let verifier: string | undefined;
  if (level.pkce) {
    const login = v.cookies[loginCookie(v.level)] ?? '';
    const pending = state.logins.get(login);
    state.logins.delete(login);
    cookies.push({ name: loginCookie(v.level), value: '', path, clear: true });
    if (pending === undefined || pending.state !== v.query.get('state')) {
      return { status: 400, cookies, text: `${SIGN_IN_FAILED}: this sign-in was not started in this browser.` };
    }
    verifier = pending.verifier;
  }
  const issued = state.codes.get(v.query.get('code') ?? '');
  const exchange: Exchange = { clientId: CLIENT_ID, redirectUri: REGISTERED_REDIRECT, ...(verifier === undefined ? {} : { verifier }) };
  if (!level.redeem(issued, exchange, state.world.now()) || issued === undefined) {
    return { status: 400, cookies, text: `${SIGN_IN_FAILED}: Pilgrim-ID did not accept the code.` };
  }
  const sid = newId();
  put(state.clientSessions, sid, issued.user);
  cookies.push({ name: clientCookie(v.level), value: sid, path });
  // The sign-in's `next`, once, and only while it holds (a stale one is dropped, never followed).
  const returnId = v.cookies[nextCookie(v.level)];
  const back = returnId === undefined ? undefined : state.returns.get(returnId);
  if (returnId !== undefined) {
    state.returns.delete(returnId);
    cookies.push({ name: nextCookie(v.level), value: '', path, clear: true });
  }
  const next = back !== undefined && state.world.now() < back.until ? back.next : undefined;
  const { forward, referrerPolicy } = level.landing(next);
  return {
    status: 200, cookies, text: `Signed in to Citadel as ${issued.user}.`, user: issued.user,
    ...(forward === undefined ? {} : { forward }), ...(referrerPolicy === undefined ? {} : { referrerPolicy }),
  };
}

/** The lab as the admin's browser sees it at http://citadel.test: the twins of the real routes, from the same functions. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const v: Visit = { level, query: r.query, cookies: r.cookies, base: '' };
  if (r.path === '/login') return toSim(startLogin(v, state));
  if (r.path === '/idp/authorize') return toSim(authorize(v, state));
  if (r.path === '/callback') return toSim(callback(v, state));
  if (r.path === '/') return { status: 200, body: 'Citadel — Home' };
  return { status: 404, body: 'Not found' };
}

// Per player AND per level: both apps' sessions, the codes, the admin's browser and the attacker log together, so one
// eviction (or TTL expiry) drops them all at once. No limiter lives here, so the shared sim budget is harmless.
const labs = perSession((level: Level): LabState => {
  const world = simWorld();
  const adminPid = newId();
  // The handler reads `state` only when the admin browses, after it is assigned.
  const state: LabState = {
    world, admin: world.browser((r) => citadel(level, state, r)), adminPassword: newId(), adminPid,
    idpSessions: new Map([[adminPid, ADMIN_NAME]]), clientSessions: new Map(), logins: new Map(), codes: new Map(), returns: new Map(),
  };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.adminPassword`, `.codes`, `.admin.cookies`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
