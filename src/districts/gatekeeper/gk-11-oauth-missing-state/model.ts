// model.ts — GK-11's lab state: Citadel (with "Link your Pilgrim-ID" and "Sign in with Pilgrim-ID") and the identity
// provider Pilgrim-ID, the pages both browsers open, and the contract every levels/<level>.ts implements. Not served:
// View Source shows only levels/*.ts. Pilgrim-ID is SOUND here at every level (exact registered redirect URIs,
// single-use codes bound to their redirect URI, PKCE verified): the lesson is Citadel's `state`, which the levels own.
// The level modules are gathered here because the admin's browser needs them too; they import only types from this file.
import { byLevel, declareLabWeight, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import {
  CITADEL_ORIGIN, cookiePath, simVisitOf, simWorld, toSim,
  type Reply, type SimBrowser, type SimRequest, type SimResponse, type SimWorld, type TwinCookie, type Visit,
} from '../../../core/sim.js';
import { ADMIN_NAME, accountOf } from '../_shared/lab.js';
import { newId, putBounded } from '../../_shared/collections.js';
import {
  CLIENT_ID, newVerifier, pilgrimIdAuthorize, pilgrimIdSignIn, pilgrimIdUser, s256,
  type IssuedCode, type PilgrimId, type PilgrimIdPolicy,
} from '../_shared/oauth.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** Citadel's two redirect URIs registered at Pilgrim-ID. */
export const LINK_REDIRECT = `${CITADEL_ORIGIN}/link/callback`;
export const LOGIN_REDIRECT = `${CITADEL_ORIGIN}/callback`;

/** One cookie name per level (levels share the lab path). */
export const clientCookie = (level: Level): string => `citadel_session_${level}`;
export const pidCookie = (level: Level): string => `pid_session_${level}`;
/** Every cookie this lab's pages read at `level`: what visitOf and simVisitOf keep, so both browsers show the same. */
export const labCookies = (level: Level): readonly string[] => [clientCookie(level), pidCookie(level)];

export type Purpose = 'link' | 'login';
/** A flow Citadel started: which Citadel session started it, what for, and (with PKCE) its verifier. */
export interface Flow { readonly session: string; readonly purpose: Purpose; readonly verifier?: string }

/** What every levels/<level>.ts exports. */
export interface StateLevel {
  /** Citadel, starting a flow: the state to send with it (state.newState(flow) remembers it), or undefined for none. */
  issueState(state: LabState, flow: Flow): string | undefined;
  /**
   * Citadel, at a callback: may the browser's Citadel session `session` finish a `purpose` flow with the state the
   * callback carried (null: none)? `flow` is the flow it finishes, when the level looked one up (it has the verifier).
   */
  acceptState(state: LabState, returned: string | null, session: string, purpose: Purpose): { readonly ok: boolean; readonly flow?: Flow };
  /** Citadel: do flows use PKCE (a verifier kept with the flow, its S256 challenge sent)? */
  readonly pkce: boolean;
}

export const impl = byLevel<StateLevel>({ acolyte, templar, inquisitor, divine });

/** One player's lab at one level. */
export interface LabState {
  /** The attacker log, the victim's visits and the clock (`world.now`, a test seam). */
  readonly world: SimWorld;
  /** The admin's browser, signed in to Citadel (re-armed before every action). */
  readonly admin: SimBrowser;
  readonly adminPassword: string;
  readonly adminPidPassword: string;
  /** The admin's Citadel session id: pinned, never pushed out. */
  readonly adminSession: string;
  /** Citadel sessions: id -> user (null: not signed in). Bounded. */
  readonly clientSessions: Map<string, string | null>;
  /** Pilgrim-ID sessions: id -> user. Bounded. */
  readonly idpSessions: Map<string, string>;
  /** Authorization codes. Bounded. */
  readonly codes: Map<string, IssuedCode>;
  /** The flows Citadel started, by the state it sent. Bounded. */
  readonly flows: Map<string, Flow>;
  /** Linked accounts: Pilgrim-ID user -> Citadel user. Keyed only by the two real Pilgrim-ID accounts. */
  readonly links: Map<string, string>;
  /** A fresh random state for `flow`, remembered (bounded). */
  newState(flow: Flow): string;
}

const MAX_ENTRIES = 50;
const put = <V>(m: Map<string, V>, key: string, value: V, keep?: (k: string) => boolean): void => putBounded(m, key, value, MAX_ENTRIES, keep);

/** Pilgrim-ID is sound in this lab at every level: only Citadel's two registered redirect URIs, and PKCE only as S256. */
const SOUND_IDP: PilgrimIdPolicy = {
  allowRedirect: (redirectUri) => redirectUri === LINK_REDIRECT || redirectUri === LOGIN_REDIRECT,
  checkPkce: (challenge, method) => (challenge !== undefined && method !== 'S256' ? 'only S256 is supported.' : undefined),
};

/** Pilgrim-ID in this lab (gatekeeper/_shared/oauth.ts), with its own admin password and the sound policy. */
const PILGRIM_ID: PilgrimId<LabState> = {
  cookie: pidCookie, adminPassword: (s) => s.adminPidPassword, maxEntries: MAX_ENTRIES, policy: () => SOUND_IDP,
};

/** The browser's Citadel session (an anonymous one is opened if it has none and `open` is set). */
function sessionOf(v: Visit, state: LabState, open: boolean): { sid: string; user: string | null; cookies: TwinCookie[] } {
  const c = v.cookies[clientCookie(v.level)];
  if (c !== undefined && state.clientSessions.has(c)) return { sid: c, user: state.clientSessions.get(c) ?? null, cookies: [] };
  if (!open) return { sid: '', user: null, cookies: [] };
  const sid = newId();
  put(state.clientSessions, sid, null, (k) => k === state.adminSession);
  return { sid, user: null, cookies: [{ name: clientCookie(v.level), value: sid, path: cookiePath(v.base) }] };
}

/** A new Citadel session for `user` (signing in always gets a fresh id). */
function signInAs(v: Visit, state: LabState, user: string | null): TwinCookie {
  const sid = newId();
  put(state.clientSessions, sid, user, (k) => k === state.adminSession);
  return { name: clientCookie(v.level), value: sid, path: cookiePath(v.base) };
}

/** Who the browser is at Citadel and at Pilgrim-ID, and which Pilgrim-IDs are linked to its Citadel account. */
export function whoIs(v: Visit, state: LabState): { readonly client?: string; readonly idp?: string; readonly linked: readonly string[] } {
  const client = state.clientSessions.get(v.cookies[clientCookie(v.level)] ?? '') ?? undefined;
  const idp = pilgrimIdUser(PILGRIM_ID, v, state);
  const linked = client === undefined ? [] : [...state.links].filter(([, c]) => c === client).map(([p]) => p);
  return { ...(client === undefined ? {} : { client }), ...(idp === undefined ? {} : { idp }), linked };
}

/** GET /: the home page opens an anonymous Citadel session for a browser without one. */
export function openHome(v: Visit, state: LabState): Reply {
  return { status: 200, text: '', cookies: sessionOf(v, state, true).cookies };
}

/** POST / : sign in to Citadel with a password. */
export function citadelSignIn(v: Visit, state: LabState, username: string, password: string): Reply & { readonly ok: boolean; readonly user?: string } {
  const user = accountOf(username, password, state.adminPassword);
  if (user === undefined) return { status: 200, ok: false, text: 'Invalid username or password.' };
  return { status: 200, ok: true, user, text: `Signed in to Citadel as ${user}.`, cookies: [signInAs(v, state, user)] };
}

/** GET /logout: a fresh, signed-out Citadel session, then home. */
export function logout(v: Visit, state: LabState): Reply {
  return { status: 302, location: `${v.base}/`, cookies: [signInAs(v, state, null)], text: '' };
}

/** POST /idp: sign in to Pilgrim-ID. */
export function idpSignIn(v: Visit, state: LabState, username: string, password: string): Reply & { readonly ok: boolean } {
  return pilgrimIdSignIn(PILGRIM_ID, v, state, username, password);
}

/** GET /link and GET /login: start a flow at Pilgrim-ID with the level's state (and PKCE). */
export function startFlow(v: Visit, state: LabState, purpose: Purpose): Reply {
  const level = impl.for(v.level);
  const { sid, cookies } = sessionOf(v, state, true);
  const verifier = level.pkce ? newVerifier() : undefined;
  const st = level.issueState(state, { session: sid, purpose, ...(verifier === undefined ? {} : { verifier }) });
  const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: purpose === 'link' ? LINK_REDIRECT : LOGIN_REDIRECT });
  if (st !== undefined) params.set('state', st);
  if (verifier !== undefined) {
    params.set('code_challenge', s256(verifier));
    params.set('code_challenge_method', 'S256');
  }
  return { status: 302, location: `${v.base}/idp/authorize?${params.toString()}`, cookies, text: '' };
}

/** GET /idp/authorize (Pilgrim-ID, sound): a signed-in user's code goes to a registered redirect URI only. */
export function authorize(v: Visit, state: LabState): Reply {
  return pilgrimIdAuthorize(PILGRIM_ID, v, state);
}

/** Pilgrim-ID's token endpoint (sound): once, for this client and redirect URI, with the verifier iff a challenge was sent. */
function redeem(state: LabState, code: string, redirectUri: string, verifier: string | undefined): string | undefined {
  const issued = state.codes.get(code);
  if (issued === undefined || issued.used) return undefined;
  issued.used = true;
  if (state.world.now() >= issued.expiresAt || issued.clientId !== CLIENT_ID || issued.redirectUri !== redirectUri) return undefined;
  if ((issued.challenge === undefined) !== (verifier === undefined)) return undefined;
  if (issued.challenge !== undefined && s256(verifier ?? '') !== issued.challenge) return undefined;
  return issued.user;
}

/** GET /link/callback: finish linking a Pilgrim-ID to the signed-in Citadel account. */
export function linkCallback(v: Visit, state: LabState): Reply & { readonly ok: boolean } {
  const { sid, user } = sessionOf(v, state, false);
  // Checked first, so a signed-out browser uses up neither the code nor the state.
  if (user === null) return { status: 200, ok: false, text: 'Sign in to Citadel to finish linking. Nothing was linked.' };
  const accepted = impl.for(v.level).acceptState(state, v.query.get('state'), sid, 'link');
  if (!accepted.ok) return { status: 400, ok: false, text: 'Linking failed: the state does not belong to a link this browser started.' };
  const pidUser = redeem(state, v.query.get('code') ?? '', LINK_REDIRECT, accepted.flow?.verifier);
  if (pidUser === undefined) return { status: 400, ok: false, text: 'Linking failed: Pilgrim-ID did not accept the code.' };
  state.links.set(pidUser, user);
  return { status: 200, ok: true, text: `Your Pilgrim-ID (${pidUser}) is now linked to your Citadel account (${user}).` };
}

/** GET /callback: "Sign in with Pilgrim-ID" lands in whichever Citadel account the Pilgrim-ID is linked to. */
export function loginCallback(v: Visit, state: LabState): Reply & { readonly user?: string } {
  const { sid } = sessionOf(v, state, false);
  const accepted = impl.for(v.level).acceptState(state, v.query.get('state'), sid, 'login');
  if (!accepted.ok) return { status: 400, text: 'Sign-in failed: the state does not belong to a sign-in this browser started.' };
  const pidUser = redeem(state, v.query.get('code') ?? '', LOGIN_REDIRECT, accepted.flow?.verifier);
  if (pidUser === undefined) return { status: 400, text: 'Sign-in failed: Pilgrim-ID did not accept the code.' };
  const user = state.links.get(pidUser);
  if (user === undefined) return { status: 200, text: `No Citadel account is linked to your Pilgrim-ID (${pidUser}).` };
  return { status: 200, text: `Signed in to Citadel as ${user}.`, user, cookies: [signInAs(v, state, user)] };
}

/** The lab as the admin's browser sees it at http://citadel.test: the twins of the real routes, from the same functions. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const v = simVisitOf(level, r, labCookies(level));
  switch (r.path) {
    case '/': return toSim({ ...openHome(v, state), text: 'Citadel — Home' });
    case '/logout': return toSim(logout(v, state));
    case '/link': return toSim(startFlow(v, state, 'link'));
    case '/login': return toSim(startFlow(v, state, 'login'));
    case '/idp/authorize': return toSim(authorize(v, state));
    case '/link/callback': return toSim(linkCallback(v, state));
    case '/callback': return toSim(loginCallback(v, state));
    default: return { status: 404, body: 'Not found' };
  }
}

// Per player AND per level: both apps' sessions, the codes, flows and links, the admin's browser and the attacker log
// together, so one eviction (or TTL expiry) drops them all at once. No limiter lives here.
/**
 * What this lab's own maps can hold at worst, in the shared byte budget (declareLabWeight): codes (a player code_challenge, clipped one past the URL cap), flows and both session maps, 50 each.
 * ~239 KiB measured filled to every cap (tests/lab-state-weights.spec.ts), plus ~10%, rounded up to 32 KiB.
 */
export const STATE_WEIGHT = 288 * 1024;

const labs = perSession((level: Level): LabState => {
  declareLabWeight(STATE_WEIGHT, 'GK-11 lab state'); // its maps; its world and browser weigh themselves
  const world = simWorld();
  const adminSession = newId();
  const flows = new Map<string, Flow>();
  // The handler reads `state` only when the admin browses, after it is assigned.
  const state: LabState = {
    world, admin: world.browser((r) => citadel(level, state, r)),
    adminPassword: newId(), adminPidPassword: newId(), adminSession,
    clientSessions: new Map([[adminSession, ADMIN_NAME]]), idpSessions: new Map(), codes: new Map(), flows,
    links: new Map([[ADMIN_NAME, ADMIN_NAME]]), // the admin's own Pilgrim-ID is linked to the admin's account
    newState(flow: Flow): string {
      const st = newId();
      put(flows, st, flow);
      return st;
    },
  };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.links`, `.flows`, `.codes`, `.adminPidPassword`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
