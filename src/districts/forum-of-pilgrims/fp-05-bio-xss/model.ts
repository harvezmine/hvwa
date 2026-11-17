// model.ts — FP-05's lab state (the player's bio, the moderator's simulated browser, the player's marker, the attacker
// log), the profile page both browsers open, and the contract every levels/<level>.ts implements. Not served: View
// Source shows only levels/*.ts. The level modules are gathered here because the moderator's browser needs them too;
// they import only types from this file, so there is no import cycle.
import { byLevel, declareLabWeight, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { escapeHtml } from '../../../core/render.js';
import type { SimRequest, SimResponse } from '../../../core/sim.js';
import { clip } from '../../../core/sim/limits.js';
import type { Result } from '../../_shared/result.js';
import { signOutPage, xssVictim, type XssVictim } from '../../_shared/xss-lab.js';
import { ADMIN_NAME, ARCHIVIST, PLAYER } from '../_shared/forum.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** What every levels/<level>.ts exports. */
export interface BioLevel {
  /**
   * The profile card's bio block: the one place the bio reaches HTML. The moderator's page and the player's preview both
   * hold exactly this fragment.
   */
  renderBio(bio: string): string;
}

export const impl = byLevel<BioLevel>({ acolyte, templar, inquisitor, divine });

/** The moderator's session cookie at http://citadel.test (what a payload that runs steals). */
export const SESSION = 'forum_session';
/** Longest bio (characters). */
export const BIO_LENGTH = 500;

/** The other members' bios: scenery, the same in every lab and at every level (lab-written plain text). */
export const MEMBER_BIOS: ReadonlyMap<string, string> = new Map([
  [ADMIN_NAME, 'Moderator of the Forum of Pilgrims. Please keep threads kind.'],
  [ARCHIVIST, 'Keeper of the old scrolls.'],
]);

/** One player's lab at one level. */
export interface LabState extends XssVictim {
  /** The player's own bio, exactly as saved (a bounded copy). */
  bio: string;
}

/** Save the player's bio (the profile form and the test seams): refused when too long, else it replaces the old one. */
export function saveBio(state: LabState, bio: string): Result {
  if (bio.length > BIO_LENGTH) return { ok: false, text: `A bio is at most ${BIO_LENGTH} characters.` };
  state.bio = clip(bio, BIO_LENGTH); // a copy, never the request's string
  return { ok: true, text: 'Your bio was saved.' };
}

/** A member's bio by name ("pilgrim" is the player's own), or undefined for anyone else (a Map: no prototype keys). */
export function bioOf(state: LabState, name: string): string | undefined {
  return name === PLAYER.username ? state.bio : MEMBER_BIOS.get(name);
}

/** http://citadel.test/u/<name>: a member's public profile, the bio as the level renders it. */
export function profilePage(level: Level, name: string, bio: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}: Forum of Pilgrims</title></head><body>`
    + `<h1>${escapeHtml(name)}</h1><p class="role">Member of the Forum of Pilgrims</p>${impl.for(level).renderBio(bio)}</body></html>`;
}

/** The lab as the moderator's browser sees it at http://citadel.test: the twins of the real routes. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const m = /^\/u\/([^/]*)$/.exec(r.path);
  if (m !== null) {
    const name = m[1]; // member names are plain ASCII: compared as written, never decoded
    const bio = bioOf(state, name);
    return bio === undefined ? { status: 404, body: '<!DOCTYPE html><p>No such member.</p>' } : { status: 200, body: profilePage(level, name, bio) };
  }
  if (r.path === '/') return { status: 200, body: '<!DOCTYPE html><h1>Forum of Pilgrims</h1>' };
  if (r.path === '/logout') return signOutPage(SESSION); // only the moderator has a session to end (citadel-only)
  return { status: 404, body: 'Not found' };
}

/**
 * What this lab's own state can hold at worst, in the shared byte budget (declareLabWeight): one bio of BIO_LENGTH
 * two-byte characters (~4 KiB measured with a full GC, fp-05.spec.ts), plus a margin.
 */
export const STATE_WEIGHT = 8 * 1024;

// Per player AND per level: the bio, the world, the marker and the moderator together, so one eviction or one Restart
// drops them all.
const labs = perSession((level: Level): LabState => {
  declareLabWeight(STATE_WEIGHT, 'FP-05 lab state'); // its bio; the world, browser and verdicts weigh themselves
  const state: LabState = { ...xssVictim(SESSION, (r) => citadel(level, state, r)), bio: '' };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.bio`, `.marker`, `.key`, `.admin.verdicts`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Restart: drop this player's lab at the served level (bio, world, marker and key). No limiter lives here. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  labs.reset(req);
}
