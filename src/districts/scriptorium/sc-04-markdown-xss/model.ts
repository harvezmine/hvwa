// model.ts — SC-04's lab state (the librarian's simulated browser, the player's marker, the attacker log), the Markdown
// GRAMMAR every level shares, the note page both browsers open, and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts. The grammar here only finds the constructs (which text is a link,
// which is an image and its title); what each construct BECOMES in HTML, escaped or not and with which URL check, is
// the level's `rules`, so the flaw lives in levels/*.ts. The level modules are gathered here because the librarian's
// browser needs them too; they import only types from this file, so there is no import cycle.
import { byLevel, perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { SIM_LIMITS, type SimRequest, type SimResponse } from '../../../core/sim.js';
import { signOutPage, xssVictim, type XssVictim } from '../../_shared/xss-lab.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

/**
 * How a level turns each Markdown construct into HTML. Every argument is the note's own text, exactly as written:
 * escaping it (or not) and checking a URL (or not) is the rule's job.
 */
export interface MarkdownRules {
  /** Plain text between constructs (and inside headings, **strong** and *emphasis*). */
  text(s: string): string;
  /** `code` */
  code(s: string): string;
  /** [label](href) */
  link(label: string, href: string): string;
  /** ![alt](src "title"): the title is optional. */
  image(alt: string, src: string, title: string | undefined): string;
}

/** What every levels/<level>.ts exports: its rules. */
export interface MarkdownLevel { readonly rules: MarkdownRules }

export const impl = byLevel<MarkdownLevel>({ acolyte, templar, inquisitor, divine });

/** The librarian's session cookie at http://citadel.test (what a payload that runs steals). */
export const SESSION = 'scriptorium_session';
/** The longest note a page renders: what a link to the librarian can carry at most (the sim's URL cap). */
export const NOTE_LENGTH = SIM_LIMITS.urlLength;

// The inline constructs, in one pattern tried left to right: an image, a link, code, strong, emphasis. A destination
// is anything but spaces and parentheses, with balanced (unnested) parentheses allowed, as CommonMark allows. An image
// title is everything from its opening quote to the quote that closes the image (the ") before its end). Each
// alternative starts with a different character and none can match the same text two ways, so a failed match costs at
// most one scan of the line: on a note of NOTE_LENGTH that is a few million steps (sc-04.spec.ts "costs little").
const DEST = String.raw`((?:[^\s()]|\([^\s()]*\))*)`;
const INLINE = new RegExp(
  String.raw`!\[([^\]\n]*)\]\(${DEST}(?:[ \t]+"([^\n]*?)")?\)` // 1 alt, 2 src, 3 title
  + String.raw`|\[([^\]\n]*)\]\(${DEST}\)` // 4 label, 5 href
  + '|`([^`\\n]+)`' // 6 code
  + String.raw`|\*\*([^*\n]+)\*\*` // 7 strong
  + String.raw`|\*([^*\n]+)\*`, // 8 emphasis
  'g',
);

function inline(s: string, r: MarkdownRules): string {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    out += r.text(s.slice(at, m.index));
    if (m[2] !== undefined) out += r.image(m[1] ?? '', m[2], m[3]);
    else if (m[5] !== undefined) out += r.link(m[4] ?? '', m[5]);
    else if (m[6] !== undefined) out += r.code(m[6]);
    else if (m[7] !== undefined) out += `<strong>${r.text(m[7])}</strong>`;
    else out += `<em>${r.text(m[8] ?? '')}</em>`;
    at = m.index + m[0].length;
  }
  return out + r.text(s.slice(at));
}

/** A note as HTML with these rules: blocks split on blank lines; "# ", "## ", "### " make headings, the rest paragraphs. */
export function markdown(src: string, r: MarkdownRules): string {
  return src.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((block) => block.trim()).filter((b) => b !== '').map((block) => {
    const h = /^(#{1,3}) (.*)$/s.exec(block);
    return h === null ? `<p>${inline(block, r)}</p>` : `<h${h[1].length}>${inline(h[2], r)}</h${h[1].length}>`;
  }).join('');
}

/** The note as this level renders it: the one fragment the librarian's page and the player's preview both hold. */
export function renderMarkdown(level: Level, md: string): string {
  return markdown(md.slice(0, NOTE_LENGTH), impl.for(level).rules);
}

/** The shared-note page as the librarian's browser gets it: a whole document around the level's fragment. */
export function notePage(level: Level, md: string): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shared note</title></head><body>'
    + `<h1>Shared note</h1><article class="note">${renderMarkdown(level, md)}</article></body></html>`;
}

/** The lab as the librarian's browser sees it at http://citadel.test: the twins of the real routes. */
function citadel(level: Level, r: SimRequest): SimResponse {
  if (r.path === '/' || r.path === '/note') return { status: 200, body: notePage(level, r.query.get('md') ?? '') };
  if (r.path === '/logout') return signOutPage(SESSION); // only the librarian has a session to end (citadel-only)
  return { status: 404, body: 'Not found' };
}

// Per player AND per level: the world, the marker, the librarian's key and browser together, so one eviction drops
// them all. The lab keeps no map of its own (the note travels in the link), so nothing needs declareLabWeight.
const labs = perSession((level: Level): XssVictim => xssVictim(SESSION, (r) => citadel(level, r)));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): XssVictim {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.marker`, `.key`, `.admin.verdicts`, `.world`). */
export function labState(sessionId: string, level: Level): XssVictim {
  return labs.for({ sessionId, level });
}
