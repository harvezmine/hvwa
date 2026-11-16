// model.ts — SC-01's lab state (the librarian's simulated browser, the player's marker, the attacker log), the search
// page both browsers open, and the contract every levels/<level>.ts implements. Not served: View Source shows only
// levels/*.ts. The level modules are gathered here because the librarian's browser needs them too; they import only
// types from this file, so there is no import cycle.
import { labHeaders, type LabHeaders } from '../../../core/http.js';
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import type { SimRequest, SimResponse } from '../../../core/sim.js';
import { signOutPage, xssVictim, type XssVictim } from '../../_shared/xss-lab.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** What every levels/<level>.ts exports. */
export interface SearchLevel {
  /**
   * The search results for the query: the one place the query reaches HTML. The librarian's page and the player's
   * preview both hold exactly this fragment, so the oracle judges what the player watches.
   */
  results(q: string): string;
  /** Headers the level adds to its search pages (Divine: a CSP, defence in depth). Absent: none. */
  readonly headers?: LabHeaders;
}

export const impl = byLevel<SearchLevel>({ acolyte, templar, inquisitor, divine });

/** The librarian's session cookie at http://citadel.test (what a payload that runs steals). */
export const SESSION = 'scriptorium_session';

/** One player's lab at one level: the librarian (signed in), the player's marker, the attacker log. Nothing else. */
export type LabState = XssVictim;

/** The search page as the librarian's browser gets it: a whole document around the level's fragment. */
export function searchPage(level: Level, q: string): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scriptorium search</title></head><body>'
    + `<h1>Scriptorium search</h1>${impl.for(level).results(q)}</body></html>`;
}

/** The lab as the librarian's browser sees it at http://citadel.test: the twins of the real routes. */
function citadel(level: Level, r: SimRequest): SimResponse {
  if (r.path === '/' || r.path === '/search') {
    return { status: 200, headers: { ...labHeaders(impl.for(level).headers ?? {}) }, body: searchPage(level, r.query.get('q') ?? '') };
  }
  if (r.path === '/logout') return signOutPage(SESSION); // only the librarian has a session to end (citadel-only)
  return { status: 404, body: 'Not found' };
}

// Per player AND per level: the world, the marker, the librarian's key and browser together, so one eviction drops
// them all. The lab keeps no map of its own (the query travels in the link), so nothing needs declareLabWeight.
const labs = perSession((level: Level): LabState => xssVictim(SESSION, (r) => citadel(level, r)));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.marker`, `.key`, `.admin.verdicts`, `.world`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
