// model.ts — GK-17's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes, randomInt } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME } from '../_shared/lab.js';

export const GUEST_NAME = 'guest';

/** The lab's session cookie. One name per level: levels share a path, and must not overwrite each other's session. */
export function cookieName(level: Level): string {
  return `citadel_sid_${level}`;
}

/** One entry of the "recent activity" panel. */
export interface Activity { user: string; epoch: number }

/** One player's lab at one level: its sessions, and the generators the levels draw tokens from. */
export interface LabState {
  /** Valid session tokens and who they belong to. */
  readonly sessions: Map<string, string>;
  /** The simulated admin's current session token. */
  adminToken: string;
  /** Sign-ins, oldest first (shown in the activity panel). */
  readonly activity: Activity[];
  /** The visitor's OWN session tokens in the order they were issued (guest, later sign-ins). Never the admin's. */
  readonly ownTokens: string[];
  /** Whether the admin has signed in yet (the lab starts on the first request). */
  booted: boolean;
  /** Acolyte's counter: the next session id. */
  counter: number;
  /** Inquisitor's generator state (48 bits). */
  lcg: bigint;
  /** The clock (ms); a test seam so token timestamps are predictable. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<TokenLevel> in challenge.ts). */
export interface TokenLevel {
  /** Mint a session token for `username` at `nowMs` (the generator is the whole lesson). */
  mint(state: LabState, username: string, nowMs: number): string;
  /** Whether the activity panel shows when each sign-in happened. */
  readonly showsLoginTime: boolean;
}

const MAX_SESSIONS = 200;

/** Mint and register a session for `username`; the admin's token is never evicted. Returns the token. */
export function startSession(level: TokenLevel, state: LabState, username: string): string {
  const nowMs = state.now(); // read the clock once: the token and the activity entry must agree
  const token = level.mint(state, username, nowMs);
  state.sessions.set(token, username);
  state.activity.push({ user: username, epoch: Math.floor(nowMs / 1000) });
  if (username === ADMIN_NAME) state.adminToken = token;
  // Keep the panel short, but never drop the admin's line: it is part of the lab (Templar reads it).
  if (state.activity.length > 20) {
    const i = state.activity.findIndex((a) => a.user !== ADMIN_NAME);
    state.activity.splice(i === -1 ? 0 : i, 1);
  }
  while (state.sessions.size > MAX_SESSIONS) {
    const oldest = [...state.sessions.keys()].find((k) => k !== state.adminToken);
    if (oldest === undefined) break;
    state.sessions.delete(oldest);
  }
  return token;
}

/** Record a token issued to the visitor (listed on the page so the issue order is visible). Bounded; the first two are pinned. */
export function giveToVisitor(state: LabState, token: string): void {
  state.ownTokens.push(token);
  // The first two tokens (the boot guest, and the one issued right after the admin's) are pinned: they
  // bracket the admin token and must never scroll away.
  if (state.ownTokens.length > 20) state.ownTokens.splice(2, 1);
}

/** Who a presented token belongs to, or undefined. Own-property lookup only (the map is not an object). */
export function whoIs(state: LabState, token: unknown): string | undefined {
  return typeof token === 'string' ? state.sessions.get(token) : undefined;
}

// Per player AND per level: the admin session, the generators' state and every issued token
// belong to one player's lab, so a hijack in one lab never touches another.
const labs = perSession((): LabState => ({
  sessions: new Map(),
  adminToken: '',
  activity: [],
  ownTokens: [],
  booted: false,
  counter: 1000 + randomInt(8000),
  lcg: BigInt(`0x${randomBytes(6).toString('hex')}`) & ((1n << 48n) - 1n),
  now: Date.now,
}));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** The "Restart lab" hook: a fresh lab (new admin session, new generators) at this level. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  labs.reset(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.adminToken` is the real admin session). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
