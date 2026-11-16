// model.ts — GK-09's lab state, its reset links and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts. The reset TOKENS are sound at every level (random, hashed at rest,
// bound to the account, single-use, 15 minutes): the lesson is only where the link that carries one points.
import { createHash, randomBytes } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { newId, putBounded } from '../../_shared/collections.js';
import {
  ADMIN_MAILBOX, CITADEL_ORIGIN, PLAYER_MAILBOX, simWorld,
  type SimBrowser, type SimRequest, type SimResponse, type SimWorld,
} from '../../../core/sim.js';
import { ADMIN_NAME, PLAYER } from '../_shared/lab.js';

/** The configured canonical base URL of the citadel: what its own mails should always link to. */
export const CANONICAL_ORIGIN = CITADEL_ORIGIN;

/** A citadel account; its address is its mailbox in the simulated world. */
export interface Member { readonly username: string; readonly email: string; password: string; readonly role: 'admin' | 'user' }

/** A request header by lower-case name, as a string (undefined when missing or repeated): client-written. */
export type HeaderOf = (name: string) => string | undefined;

/** What every levels/<level>.ts exports (checked by byLevel<LinkLevel> in challenge.ts). */
export interface LinkLevel {
  /**
   * The origin (scheme://host) the citadel's own absolute links are built on for this request: the reset link in the
   * mail, and the "sent" page the form redirects to. `headerOf` reads the request's headers.
   */
  linkOrigin(headerOf: HeaderOf): string;
}

/** One player's lab at one level. */
export interface LabState {
  /** The inbox (the player's mailbox and the admin's), the attacker log and the clock (`world.now`, a test seam). */
  readonly world: SimWorld;
  /** The admin's browser: it opens the newest mail in the admin's mailbox and clicks its link. */
  admin: SimBrowser;
  /** The admin first, then the player. */
  readonly members: readonly Member[];
  /** Outstanding reset links: SHA-256 of the token -> the account and expiry. Oldest first, bounded. */
  readonly resets: Map<string, { readonly email: string; readonly expiresAt: number }>;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_RESETS = 20;
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The account with this address (trimmed, lower case), or undefined. Only the two real accounts exist. */
export function memberByEmail(state: LabState, email: string): Member | undefined {
  const wanted = email.trim().toLowerCase();
  return state.members.find((m) => m.email === wanted);
}

/** A new reset token for `member` (32 CSPRNG bytes); only its hash is kept. */
export function issueReset(state: LabState, member: Member): string {
  const token = randomBytes(32).toString('base64url');
  putBounded(state.resets, hash(token), { email: member.email, expiresAt: state.world.now() + FIFTEEN_MINUTES }, MAX_RESETS);
  return token;
}

/** The account a live token resets (it stays usable): what the reset page checks before showing its form. */
export function checkReset(state: LabState, token: string): Member | undefined {
  const r = state.resets.get(hash(token));
  return r === undefined || state.world.now() >= r.expiresAt ? undefined : memberByEmail(state, r.email);
}

/** Use a token up: the account it resets, or undefined. */
export function redeemReset(state: LabState, token: string): Member | undefined {
  const member = checkReset(state, token);
  state.resets.delete(hash(token));
  return member;
}

export const RESET_PAGE = 'Choose a new password.';
export const RESET_INVALID = 'This reset link is invalid or has expired.';

/**
 * The lab as the admin's browser sees it at http://citadel.test, in process. The twin of the real routes: `/reset` is
 * `<lab>/reset` and answers from the same checkReset(). The admin only ever opens a link; nothing here signs in.
 */
function citadel(state: LabState, r: SimRequest): SimResponse {
  if (r.path === '/reset') {
    const token = r.query.get('token') ?? '';
    return checkReset(state, token) === undefined ? { status: 200, body: RESET_INVALID } : { status: 200, body: RESET_PAGE };
  }
  if (r.path === '/') return { status: 200, body: 'Citadel Gate — Sign in' };
  return { status: 404, body: 'Not found' };
}

// Per player AND per level: the inbox, the attacker log, the admin's browser and the passwords together, so one
// eviction (or TTL expiry) drops them all at once. No limiter lives here, so the shared sim budget is harmless.
const labs = perSession((_level: Level): LabState => {
  const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
  const members: Member[] = [
    { username: ADMIN_NAME, email: ADMIN_MAILBOX, password: newId(), role: 'admin' },
    { username: PLAYER.username, email: PLAYER_MAILBOX, password: PLAYER.password, role: 'user' },
  ];
  // The handler reads `state` only when the admin browses, after it is assigned.
  const state: LabState = { world, admin: world.browser((r) => citadel(state, r)), members, resets: new Map() };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.world.inbox` holds the admin's mail). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
