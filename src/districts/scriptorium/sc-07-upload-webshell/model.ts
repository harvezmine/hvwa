// model.ts — SC-07's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { newDesk, type DeskLevel, type DeskState } from '../_shared/desk.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** The level modules, checked against the desk contract: `store` (the filter) and `serve` (what the server runs). */
export const impl = byLevel<DeskLevel>({ acolyte, templar, inquisitor, divine });

// One simulated archive server per player AND per level: the scrolls (and the flag only one of them can earn) belong to
// one lab. The upload labs keep no limiter, so Restart lab is safe.
const desks = perSession((): DeskState => newDesk());

export function labFor(req: { sessionId: string; level: Level }): DeskState {
  return desks.for(req);
}

/** The body of the lab's `reset` hook. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  desks.reset(req);
}
