// _shared/oauth.ts — plumbing the Pilgrim-ID labs (GK-10, GK-11) share: PKCE's verifier and S256, the code record,
// and Pilgrim-ID's own sign-in and /idp/authorize (random ids and bounded maps live in
// districts/_shared/collections.ts, withParams in districts/_shared/url.ts, re-exported here). No policy lives here:
// which redirect_uri Pilgrim-ID accepts and what it asks of PKCE come in as callbacks (PilgrimId.policy), and which
// state Citadel honours, whether a code is single-use or bound to a verifier is each lab's level decision (levels/*.ts,
// where View Source and the Diff show it).
import { createHash, randomBytes } from 'node:crypto';
import type { Level } from '../../../core/levels.js';
import { cookiePath, type Reply, type Visit } from '../../../core/sim.js';
import { newId, putBounded } from '../../_shared/collections.js';
import { withParams } from '../../_shared/url.js';
import { accountOf } from './lab.js';

// District-agnostic (districts/_shared/url.ts), re-exported so the Gatekeeper imports stay as they were.
export { withParams } from '../../_shared/url.js';

/** Citadel's client id at Pilgrim-ID. */
export const CLIENT_ID = 'citadel';

/** How long an authorization code Pilgrim-ID issues stays redeemable (ms of the lab clock). */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** A fresh PKCE code_verifier (32 CSPRNG bytes, base64url). */
export const newVerifier = (): string => randomBytes(32).toString('base64url');
/** PKCE's S256: base64url(SHA-256(verifier)). */
export const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** An authorization code Pilgrim-ID issued. */
export interface IssuedCode {
  readonly user: string;
  readonly clientId: string;
  /** The redirect_uri it was sent to. */
  readonly redirectUri: string;
  /** The PKCE code_challenge (S256) the authorize request carried, if any. */
  readonly challenge?: string;
  readonly expiresAt: number;
  used: boolean;
}

/** What Citadel presents at Pilgrim-ID's token endpoint to redeem a code. */
export interface Exchange {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The PKCE code_verifier, when the sign-in used PKCE. */
  readonly verifier?: string;
}

// --- Pilgrim-ID itself: sign-in and /idp/authorize -----------------------------------------------------------------

/** Pilgrim-ID's part of a lab's per-session state. */
export interface PilgrimIdState {
  /** Pilgrim-ID sessions: id -> user. Bounded (PilgrimId.maxEntries). */
  readonly idpSessions: Map<string, string>;
  /** Authorization codes: code -> what it was issued for. Bounded (PilgrimId.maxEntries). */
  readonly codes: Map<string, IssuedCode>;
  /** The lab clock (`world.now`, a test seam): codes expire CODE_TTL_MS after they are issued. */
  readonly world: { readonly now: () => number };
}

/** Pilgrim-ID's checks at /idp/authorize: the POLICY, from the lab's level file (GK-10) or the lab's sound rules (GK-11). */
export interface PilgrimIdPolicy {
  /** May a code for client citadel be sent to this (non-empty) redirect_uri? */
  allowRedirect(redirectUri: string): boolean;
  /** Refuse the request for its PKCE challenge (an error text, shown after "Pilgrim-ID: ") or accept it (undefined). */
  checkPkce(challenge: string | undefined, method: string | undefined): string | undefined;
}

/** One lab's Pilgrim-ID: its plumbing, and its policy per level as a callback (as mountJwtPortal takes `verify`). */
export interface PilgrimId<S extends PilgrimIdState> {
  /** The Pilgrim-ID session cookie at `level` (one name per level). */
  readonly cookie: (level: Level) => string;
  /** The admin's Pilgrim-ID password in this lab state. */
  readonly adminPassword: (state: S) => string;
  /** A session the lab depends on (the admin's, signed in up front): never pushed out of the bounded sessions. */
  readonly pinnedSession?: (state: S) => string;
  /** Most sessions, and most codes, kept. */
  readonly maxEntries: number;
  /** The policy at `level`, e.g. `(level) => impl.for(level)` so the level file decides. */
  readonly policy: (level: Level) => PilgrimIdPolicy;
}

/** Who the browser is signed in as at Pilgrim-ID (its session cookie), or undefined. */
export function pilgrimIdUser<S extends PilgrimIdState>(id: PilgrimId<S>, v: Visit, state: S): string | undefined {
  return state.idpSessions.get(v.cookies[id.cookie(v.level)] ?? '');
}

/** Sign in to Pilgrim-ID (the admin, or pilgrim/pilgrim): a fresh session id, set as the level's cookie on the lab's base. */
export function pilgrimIdSignIn<S extends PilgrimIdState>(
  id: PilgrimId<S>, v: Visit, state: S, username: string, password: string,
): Reply & { readonly ok: boolean } {
  const user = accountOf(username, password, id.adminPassword(state));
  if (user === undefined) return { status: 200, ok: false, text: 'Invalid username or password.' };
  const sid = newId();
  const pinned = id.pinnedSession?.(state);
  putBounded(state.idpSessions, sid, user, id.maxEntries, (k) => k === pinned);
  return { status: 200, ok: true, text: `Signed in to Pilgrim-ID as ${user}.`, cookies: [{ name: id.cookie(v.level), value: sid, path: cookiePath(v.base) }] };
}

/**
 * GET /idp/authorize: a signed-in user's code for client citadel goes to the redirect_uri, with the request's state,
 * when the policy allows that redirect_uri and the PKCE challenge. Codes expire after CODE_TTL_MS.
 */
export function pilgrimIdAuthorize<S extends PilgrimIdState>(id: PilgrimId<S>, v: Visit, state: S): Reply {
  const policy = id.policy(v.level);
  const user = pilgrimIdUser(id, v, state);
  if (user === undefined) return { status: 200, text: 'Pilgrim-ID: sign in first, then open this link again.' };
  if (v.query.get('client_id') !== CLIENT_ID) return { status: 400, text: 'Pilgrim-ID: unknown client.' };
  if (v.query.get('response_type') !== 'code') return { status: 400, text: 'Pilgrim-ID: unsupported response_type.' };
  const redirectUri = v.query.get('redirect_uri') ?? '';
  if (redirectUri === '' || !policy.allowRedirect(redirectUri)) {
    return { status: 400, text: 'Pilgrim-ID: this redirect_uri is not registered for the client.' };
  }
  const challenge = v.query.get('code_challenge') ?? undefined;
  const pkceError = policy.checkPkce(challenge, v.query.get('code_challenge_method') ?? undefined);
  if (pkceError !== undefined) return { status: 400, text: `Pilgrim-ID: ${pkceError}` };
  const code = newId();
  putBounded(state.codes, code, {
    user, clientId: CLIENT_ID, redirectUri, ...(challenge === undefined ? {} : { challenge }),
    expiresAt: state.world.now() + CODE_TTL_MS, used: false,
  }, id.maxEntries);
  const st = v.query.get('state');
  return { status: 302, location: withParams(redirectUri, { code, ...(st === null ? {} : { state: st }) }), text: '' };
}
