// model.ts — GK-18's cookie names, per-player session store and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts.
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

/** The lab's role cookie. One name per level: levels share a path and must not overwrite each other. */
export function cookieName(level: Level): string {
  return `citadel_role_${level}`;
}

/** Who a cookie says the caller is. */
export interface Identity { user: string; role: string }

/** One player's lab at one level: the server-side sessions (only Divine uses them). */
export interface LabState { readonly sessions: Map<string, Identity> }
const labs = perSession((): LabState => ({ sessions: new Map() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });

export const MAX_SESSIONS = 20;

/** What every levels/<level>.ts exports (checked by byLevel<RoleLevel> in challenge.ts). */
export interface RoleLevel {
  /** Whether the cookie is HttpOnly (a session id should be; the other levels' cookies are meant to be edited). */
  readonly httpOnly: boolean;
  /** The cookie value for a freshly signed-in user. */
  issue(state: LabState, who: Identity): string;
  /** Who the presented cookie says the caller is, or undefined. `cookie` is whatever the client sent. */
  read(state: LabState, cookie: unknown): Identity | undefined;
}
