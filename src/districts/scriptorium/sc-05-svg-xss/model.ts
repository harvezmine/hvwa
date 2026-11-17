// model.ts — SC-05's lab state, the contract every levels/<level>.ts implements, and the simulated gallery the
// moderator's browser visits (the citadel handler). Not served: View Source shows only levels/*.ts. Victim-driven, so
// the level modules are gathered here (the handler needs them); the level files import only types from this file.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { simWorld, type SimRequest, type SimResponse, type SimWorld } from '../../../core/sim.js';
import { simFs, type SimFs } from '../../../core/simfs.js';
import { newMarker, xssBrowser, type XssBrowser, type XssMarker } from '../../../core/xss.js';
import { newId } from '../../_shared/collections.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/** Where the gallery keeps the player's sigil: one at a time (an upload replaces it), so a review page holds ONE sigil. */
export const SIGIL = '/srv/gallery/sigil.svg';
/**
 * The largest sigil, in bytes (plan amendment after the E0 review): with the review page around it, the page the
 * moderator's browser renders stays under the oracle's 16 KiB (XSS_LIMITS.htmlLength), so it is always judged whole.
 */
export const SIGIL_MAX_BYTES = 12 * 1024;
/** The moderator's session cookie on the simulated gallery: what a payload that runs steals. */
export const SESSION = 'gallery_session';

/** What a level's filter decides for an uploaded sigil: the text to store, or why it is refused. */
export type Accepted = { readonly ok: true; readonly svg: string } | { readonly ok: false; readonly text: string };

/** The simulated server's whole answer to GET /review: every header it sends, and the body. */
export interface Review {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What every levels/<level>.ts exports (checked by byLevel<SigilLevel>). */
export interface SigilLevel {
  /** The upload filter: refuse the sigil (the uploaded bytes as UTF-8 text), or return the text the gallery stores. */
  accept(svg: string): Accepted;
  /** How the gallery answers the moderator's GET /review of the stored sigil: the headers and the body. */
  review(sigil: string): Review;
}

export const impl = byLevel<SigilLevel>({ acolyte, templar, inquisitor, divine });

/**
 * The stored sigil handed back as a file, by both browsers' GET /sigil: never as an active type, whatever it holds
 * (docs/RECIPES.md section 9). The same at every level: the lesson is the review, and the player's real browser must
 * never render an uploaded SVG outside the sandboxed preview.
 */
export const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'attachment', 'Content-Security-Policy': 'sandbox',
});

/** One player's gallery at one level. */
export interface SigilLab {
  readonly fs: SimFs;
  readonly world: SimWorld;
  readonly marker: XssMarker;
  /** The moderator's session value: the payload's canary, and what the player signs in with. */
  readonly key: string;
  readonly moderator: XssBrowser;
}

const html = (body: string): SimResponse => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });

/** The gallery as the moderator's browser sees it at http://citadel.test: in process, never HTTP. A raw SimResponse. */
export function citadel(level: Level, lab: SigilLab, r: SimRequest): SimResponse {
  if (r.path === '/review') {
    const file = lab.fs.read(SIGIL);
    if (file === undefined) return html('<h1>Sigil review</h1>\n<p>No sigil to review.</p>');
    const answer = impl.for(level).review(file.bytes.toString('utf8')); // the level decides every header and the body
    return { status: 200, headers: { ...answer.headers }, body: answer.body };
  }
  if (r.path === '/sigil') {
    const file = lab.fs.read(SIGIL);
    if (file === undefined) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'No sigil.' };
    return { status: 200, headers: { ...DOWNLOAD_HEADERS }, body: file.bytes.toString('utf8') };
  }
  if (r.path === '/') return html('<h1>Sigil gallery</h1>');
  return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
}

// One gallery per player AND per level: the sigil, the moderator (signed in), the attacker log and the marker belong
// to one lab. Its weight (a world, an XSS browser and a file system) is declared by those stores themselves. The lab
// keeps no limiter, so Restart lab is safe.
const labs = perSession((level): SigilLab => {
  const world = simWorld();
  const marker = newMarker();
  const key = newId();
  // Typed, not `as SigilLab`: the handler reads `lab` only when the moderator browses, after the const is assigned.
  const lab: SigilLab = {
    fs: simFs(), world, marker, key,
    // The payload "sends document.cookie home": the moderator's session, read once the review page's cookies are set.
    moderator: xssBrowser(world, (r) => citadel(level, lab, r), { marker: marker.call, canary: () => lab.moderator.cookies.get(SESSION) ?? '' }),
  };
  lab.moderator.cookies.set(SESSION, key); // already signed in to the gallery
  return lab;
});

export function labFor(req: { sessionId: string; level: Level }): SigilLab {
  return labs.for(req);
}

/** The body of the lab's `reset` hook. */
export function resetLab(req: { sessionId: string; level: Level }): void {
  labs.reset(req);
}
