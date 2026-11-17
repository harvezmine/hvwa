// model.ts — SC-09's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { placeholderImage } from '../../../core/upload.js';
import { newDesk, type DeskLevel, type DeskState } from '../_shared/desk.js';
import * as acolyte from './levels/acolyte.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** The level modules, checked against the desk contract: `store` (the image check) and `serve` (what the server runs). */
export const impl = byLevel<DeskLevel>({ acolyte, inquisitor, divine });

/** The sample profile image every desk starts with: one the server made (64 x 64 declared, 35 bytes). */
export const SAMPLE = placeholderImage({ width: 64, height: 64 });

// One simulated archive server per player AND per level. The upload labs keep no limiter, so Restart lab is safe.
const desks = perSession((): DeskState => newDesk({ seed: { name: 'pilgrim.gif', bytes: SAMPLE, contentType: 'image/gif' } }));

export function labFor(req: { sessionId: string; level: Level }): DeskState {
  return desks.for(req);
}

/** The body of the lab's `reset` hook. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  desks.reset(req);
}
