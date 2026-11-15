// model.ts — GK-13's per-player sign-in state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts.
import type { Request, RequestHandler, Router } from 'express';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

/** One player's lab at one level: who they are signed in as. 'admin' is only reachable through a test seam. */
export interface LabState { user: 'none' | 'pilgrim' | 'admin' }
const labs = perSession((): LabState => ({ user: 'none' }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });

/** What the challenge hands a level so the level can wire its own guard and routes. */
export interface Wiring {
  /** Is the caller (by session) the citadel admin? */
  isAdmin(req: Request): boolean;
  /** The admin function itself: the member export. */
  exportPage: RequestHandler;
  /** The "Admin only" answer. */
  denied: RequestHandler;
}

export interface AdminLevel {
  /** Register this level's guard and routes, in this level's order, on the router it is given. */
  install(router: Router, w: Wiring): void;
  /** Lines of the lab's robots.txt below "User-agent: *". */
  readonly robots: readonly string[];
  /** The paths the served openapi.json documents (relative to the lab). */
  readonly openapi: Readonly<Record<string, { summary: string; deprecated?: boolean }>>;
}
