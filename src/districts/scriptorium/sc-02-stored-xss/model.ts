// model.ts — SC-02's lab state (the reviews, the moderator's simulated browser, the player's marker, the attacker log),
// the pages both browsers open, and the contract every levels/<level>.ts implements. Not served: View Source shows
// only levels/*.ts. The level modules are gathered here because the moderator's browser needs them too; they import
// only types from this file, so there is no import cycle.
import { byLevel, declareLabWeight, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { escapeHtml } from '../../../core/render.js';
import type { SimRequest, SimResponse } from '../../../core/sim.js';
import { clip } from '../../../core/sim/limits.js';
import type { Result } from '../../_shared/result.js';
import { signOutPage, xssVictim, type XssVictim } from '../../_shared/xss-lab.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** What every levels/<level>.ts exports. */
export interface ReviewLevel {
  /**
   * A stored review's body as the review page shows it: the one place the player's text reaches HTML. The moderator's
   * page and the player's preview both hold exactly this fragment.
   */
  renderReview(body: string): string;
}

export const impl = byLevel<ReviewLevel>({ acolyte, templar, inquisitor, divine });

/** The moderator's session cookie at http://citadel.test (what a payload that runs steals). */
export const SESSION = 'scriptorium_session';
/** The scroll everyone reviews (scenery). */
export const SCROLL = 'The Pilgrim\'s Psalter';
/** Reviews kept per player and level: the newest; the oldest goes. */
export const MAX_REVIEWS = 20;
/** Longest review (characters). A review page stays well under the oracle's 16 KiB even fully escaped. */
export const REVIEW_LENGTH = 1000;

/** One stored review: the server's number and the body exactly as posted (a bounded copy). */
export interface Review { readonly id: number; readonly body: string }

/** One player's lab at one level. */
export interface LabState extends XssVictim {
  /** The stored reviews, oldest first, at most MAX_REVIEWS. */
  readonly reviews: Review[];
  /** The next review's number (never reused, so a review page's address stays its own). */
  nextId: number;
}

/** Store a review (the add-review form and the test seams): refused when empty or too long, else kept (newest last). */
export function addReview(state: LabState, body: string): Result & { readonly review?: Review } {
  if (body.trim() === '') return { ok: false, text: 'Write a review first.' };
  if (body.length > REVIEW_LENGTH) return { ok: false, text: `A review is at most ${REVIEW_LENGTH} characters.` };
  const review: Review = Object.freeze({ id: state.nextId++, body: clip(body, REVIEW_LENGTH) }); // a copy, never the request's string
  state.reviews.push(review);
  if (state.reviews.length > MAX_REVIEWS) state.reviews.shift();
  return { ok: true, text: 'Your review was added.', review };
}

/** A review by its number as written in a path ("3"), or undefined (compared as text, never used as a key). */
export const reviewById = (state: LabState, id: string): Review | undefined => state.reviews.find((r) => String(r.id) === id);

const doc = (title: string, body: string): string =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** http://citadel.test/scroll: the scroll and its list of reviews (numbers and links only; no review text here). */
export function scrollPage(state: LabState): string {
  const items = state.reviews.map((r) => `<li><a href="/review/${r.id}">Review #${r.id}</a> by pilgrim</li>`).join('');
  return doc(SCROLL, `<h1>${escapeHtml(SCROLL)}</h1><h2>Reviews</h2><ul class="reviews">${items}</ul>`);
}

/** http://citadel.test/review/<id>: one review, its body as the level renders it. */
export function reviewPage(level: Level, review: Review): string {
  return doc(`Review #${review.id}`, `<h1>${escapeHtml(SCROLL)}: review #${review.id}</h1>`
    + `<article class="review"><p class="by">by pilgrim</p><div class="body">${impl.for(level).renderReview(review.body)}</div></article>`);
}

/** The lab as the moderator's browser sees it at http://citadel.test: the twins of the real routes. */
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  if (r.path === '/' || r.path === '/scroll') return { status: 200, body: scrollPage(state) };
  const m = /^\/review\/([^/]*)$/.exec(r.path);
  if (m !== null) {
    const review = reviewById(state, m[1]);
    return review === undefined ? { status: 404, body: doc('Not found', '<p>No such review.</p>') } : { status: 200, body: reviewPage(level, review) };
  }
  if (r.path === '/logout') return signOutPage(SESSION); // only the moderator has a session to end (citadel-only)
  return { status: 404, body: 'Not found' };
}

/**
 * What this lab's own state can hold at worst, in the shared byte budget (declareLabWeight): MAX_REVIEWS reviews of
 * REVIEW_LENGTH two-byte characters (~48 KiB measured with a full GC, sc-02.spec.ts), plus a margin.
 */
export const STATE_WEIGHT = 64 * 1024;

// Per player AND per level: the reviews, the world, the marker and the moderator together, so one eviction or one
// Restart drops them all.
const labs = perSession((level: Level): LabState => {
  declareLabWeight(STATE_WEIGHT, 'SC-02 lab state'); // its reviews; the world, browser and verdicts weigh themselves
  const state: LabState = { ...xssVictim(SESSION, (r) => citadel(level, state, r)), reviews: [], nextId: 1 };
  return state;
});

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.reviews`, `.marker`, `.key`, `.admin.verdicts`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Restart: drop this player's lab at the served level (reviews, world, marker and key). No limiter lives here. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  labs.reset(req);
}
