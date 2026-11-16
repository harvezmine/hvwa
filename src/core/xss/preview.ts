// src/core/xss/preview.ts — the one place attacker HTML really runs: the player's own browser, inside a sandboxed frame
// (owner decision Q5). sandbox="allow-scripts" WITHOUT allow-same-origin gives the frame an opaque origin: the payload
// fires and the player sees it, but the frame cannot read the lab's cookies (document.cookie throws there), cannot
// script the platform page, and cannot call /api/submit with the player's session. The flag still comes only from the
// server-side oracle; what the player sees here is decorative.
import { XSS_LIMITS } from './limits.js';
import { markerNonce } from './marker.js';

/** The frame's sandbox: scripts, nothing else (no same-origin, no forms, no popups, no top navigation, no modals). */
export const PREVIEW_SANDBOX = 'allow-scripts';

/**
 * The frame document's own policy (a meta CSP, first in its head): inline script and style for the payload and the
 * banner, data: images and media (a failed load still fires onerror), and no request at all leaving the frame: no
 * fetch, no form post, no image from the lab or anywhere else. A route-scoped CSP on the lab page also applies inside
 * (a srcdoc frame inherits its parent's policy), so a Divine level's CSP is visible here as a browser would apply it.
 */
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
  + "media-src data:; font-src data:; frame-src data:; form-action 'none'; base-uri 'none'";

export interface PreviewOptions {
  /** The player's marker call (newMarker().call): the banner says whether a call it sees is theirs. */
  readonly marker?: string;
  /** The frame's accessible name. Default 'Sandboxed preview'. */
  readonly title?: string;
  /**
   * `location.hash` inside the frame, set before the fragment loads: a DOM-XSS lab's `#...`, so its real client script
   * (part of the fragment) reads the same hash the server-side twin was given.
   */
  readonly hash?: string;
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A JavaScript string literal that cannot end the script element it sits in. */
const jsString = (s: string): string =>
  JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const STYLE = '.hvwa-fired{font:600 13px/1.4 system-ui,sans-serif;margin:0 0 6px;padding:4px 8px;border-radius:4px;'
  + 'background:#fde68a;color:#78350f}.hvwa-fired.hvwa-yours{background:#bbf7d0;color:#14532d}';

/** Runs first in the frame: hvwa() and the dialogs show a banner (as text). */
function shim(nonce: string, hash: string): string {
  return '(function(){'
    + `var want=${jsString(nonce)};`
    + 'function say(t,c){var b=document.body||document.documentElement;var p=document.createElement("p");'
    + 'p.className="hvwa-fired"+(c?" "+c:"");p.textContent=t;b.insertBefore(p,b.firstChild);}'
    + 'window.hvwa=function(n){n=String(n);var yours=want!==""&&n===want;'
    + 'say("hvwa(\'"+n+"\') ran"+(want===""?"":yours?": your marker":": not your marker"),yours?"hvwa-yours":"");};'
    + 'window.alert=function(m){say("alert("+String(m)+")");};'
    + 'window.confirm=function(m){say("confirm("+String(m)+")");return false;};'
    + 'window.prompt=function(m){say("prompt("+String(m)+")");return null;};'
    + (hash === '' ? '' : `try{location.hash=${jsString(hash)};}catch(e){}`)
    + '})();';
}

/**
 * The lab view's live preview of the vulnerable fragment: `<iframe sandbox="allow-scripts" srcdoc="...">`, safe to
 * output raw (every byte of the frame document is escaped into the srcdoc attribute). Pass the SAME fragment the level
 * built for the victim's page, so what the player watches and what the oracle judged agree. A fragment over
 * XSS_LIMITS.htmlLength (the oracle's cap) is omitted with a note.
 */
export function previewFrame(fragment: string, opts: PreviewOptions = {}): string {
  const nonce = opts.marker === undefined ? '' : markerNonce(opts.marker);
  const html = typeof fragment === 'string' ? fragment : '';
  const body = html.length > XSS_LIMITS.htmlLength
    ? `<p>Preview omitted: the fragment is over ${XSS_LIMITS.htmlLength} characters, more than the oracle reads.</p>`
    : html;
  const doc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PREVIEW_CSP)}">`
    + `<style>${STYLE}</style><script>${shim(nonce, typeof opts.hash === 'string' ? opts.hash : '')}</script>`
    + `</head><body>${body}</body></html>`;
  const title = typeof opts.title === 'string' ? opts.title : 'Sandboxed preview';
  return `<iframe class="xss-preview" sandbox="${PREVIEW_SANDBOX}" referrerpolicy="no-referrer" title="${escapeAttr(title)}" srcdoc="${escapeAttr(doc)}"></iframe>`;
}
