// model.ts — FP-08's lab state (the admin's simulated browser and the attacker log), the share-link page both browsers
// open, and the contract every levels/<level>.ts implements. Not served: View Source shows only levels/*.ts. The level
// modules are gathered here because the admin's simulated browser needs them too; they import only types from this
// file, so there is no import cycle.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import {
  REDIRECT_STATUSES, classifySimUrl, simVisitOf, simWorld, toSim,
  type Reply, type SimBrowser, type SimRequest, type SimResponse, type SimWorld, type Visit,
} from '../../../core/sim.js';
import { threadById } from '../_shared/forum.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** What every levels/<level>.ts exports. */
export interface RedirectLevel {
  /** GET /go: may the share link continue to this `next`? The level's own check; never the platform's classifier. */
  allowNext(next: string): boolean;
}

export const impl = byLevel<RedirectLevel>({ acolyte, templar, inquisitor, divine });

/** One player's lab at one level. */
export interface LabState {
  /** The attacker log, the admin's visits and the clock (`world.now`, a test seam). */
  readonly world: SimWorld;
  /** The admin's browser: it opens whatever share link the player sends. */
  readonly admin: SimBrowser;
  /** Whether the admin's browser has arrived at the player's server by way of /go (the flag's proof). */
  escaped: boolean;
}

export const REFUSED = 'Refused: a share link may only continue to a page of this forum.';

/**
 * GET /go (the share link): move on to `next`. The level decides whether it may; this page only builds the Reply.
 * Both browsers call it: the admin's on http://citadel.test/go (a Location the simulated browser follows), and the
 * player's at <lab>/go, where sendReply answers every Location through sendSimRedirect (never res.redirect).
 */
export function go(v: Visit): Reply {
  const next = v.query.get('next') ?? '';
  if (next === '') return { status: 302, location: `${v.base}/`, text: '' };
  if (!impl.for(v.level).allowNext(next)) return { status: 400, text: REFUSED };
  return { status: 302, location: next, text: '' };
}

/** GET /thread/<id>: a forum thread (a path that exists on both hosts, so a local `next` has somewhere to land). */
export function thread(id: string): Reply & { readonly title?: string } {
  const t = threadById(id);
  return t === undefined ? { status: 404, text: 'Thread not found.' } : { status: 200, text: `${t.title} (by ${t.author})`, title: t.title };
}

/** The lab as the admin's browser sees it at http://citadel.test: the twins of the real routes, from the same functions. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const v = simVisitOf(level, r, []);
  if (r.path === '/go') {
    const reply = go(v);
    // The ground truth of where the admin's browser goes next, resolved as the simulated browser resolves a Location.
    if (reply.location !== undefined && REDIRECT_STATUSES.has(reply.status) && classifySimUrl(reply.location, r.url).site === 'attacker') {
      state.escaped = true;
    }
    return toSim(reply);
  }
  const m = /^\/thread\/([^/]*)$/.exec(r.path);
  if (m !== null) return toSim(thread(m[1]));
  if (r.path === '/') return { status: 200, body: 'Forum of Pilgrims - Home' };
  return { status: 404, body: 'Not found' };
}

// Per player AND per level: the world (attacker log, visits), the admin's browser and the flag's proof together, so one
// eviction drops them all. No limiter and no map of the lab's own live here, so nothing needs declareLabWeight.
const labs = perSession((level: Level): LabState => {
  const world = simWorld();
  // The handler reads `state` only when the admin browses, after it is assigned.
  const state: LabState = { world, admin: world.browser((r) => citadel(level, state, r)), escaped: false };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.world.visits`, `.escaped`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
