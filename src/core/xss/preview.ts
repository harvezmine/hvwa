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

/**
 * A sandboxed frame never runs a javascript: URL that a click navigates to (headless Chrome 157, with or without the
 * meta CSP), so the payloads the oracle counts on a link would never be seen firing. The shim catches the click on a
 * link (a, area) or a submit button with a form owner (its formaction, else its form's action), decodes the URL exactly
 * as the oracle does (core/xss/rules.ts urlText, schemeOf, javascriptSource: leading and trailing C0 controls and
 * spaces stripped, tabs and newlines removed, the scheme compared case-insensitively, the rest percent-decoded as
 * UTF-8 bytes; entities are already undone by the parser), cancels the navigation and runs the code as an inline
 * script in the frame. The frame stays sandboxed (scripts only, opaque origin); a page CSP that forbids inline script
 * blocks it, as it blocks every inline payload. tests/xss-preview.spec.ts checks the decoding against the oracle's.
 *
 * Which URL a link follows is its EFFECTIVE one. An HTML a or area: its href attribute. An SVG a: `el.href.animVal`
 * (an SVGAnimatedString), which is the href attribute, else xlink:href (declared or not: the HTML parser puts
 * xlink:href in the XLink namespace either way), else what a SMIL animation of href (animate, set) made it now. An
 * anchor that is no link (an HTML a or area with no href, an SVG a whose effective href is empty) does not stop the
 * click: the nearest link or button around it takes it, as `a[href]` in closest() did before SVG anchors counted.
 */
const JS_LINKS = 'function jsCode(v){if(typeof v!=="string")return null;var a=0,b=v.length;'
  + 'while(a<b&&v.charCodeAt(a)<=32)a++;while(b>a&&v.charCodeAt(b-1)<=32)b--;'
  + 'var s=v.slice(a,b).replace(/[\\t\\n\\r]/g,"");var m=/^([a-zA-Z][a-zA-Z0-9+\\-.]*):/.exec(s);'
  + 'if(!m||m[1].toLowerCase()!=="javascript")return null;'
  + 'var x=new TextEncoder().encode(s.slice(s.indexOf(":")+1)),o=new Uint8Array(x.length),n=0;'
  + 'function h(c){return c>=48&&c<=57?c-48:c>=65&&c<=70?c-55:c>=97&&c<=102?c-87:-1;}'
  + 'for(var i=0;i<x.length;i++){if(x[i]===37&&i+2<x.length&&h(x[i+1])>=0&&h(x[i+2])>=0){o[n++]=h(x[i+1])*16+h(x[i+2]);i+=2;}else o[n++]=x[i];}'
  + 'return new TextDecoder().decode(o.subarray(0,n));}'
  + 'var SVG_NS="http://www.w3.org/2000/svg";'
  + 'function svgA(el){return el.localName==="a"&&el.namespaceURI===SVG_NS;}'
  + 'function svgHref(el){var h=el.href;return h&&typeof h.animVal==="string"?h.animVal:"";}'
  + 'function activated(n){var sel="a,area,button,input";'
  + 'for(var el=n&&n.closest?n.closest(sel):null;el;el=el.parentElement?el.parentElement.closest(sel):null){'
  + 'if(svgA(el)){if(svgHref(el)!=="")return el;continue;}'
  + 'if((el.localName==="a"||el.localName==="area")&&!el.hasAttribute("href"))continue;'
  + 'return el;}return null;}'
  + 'function jsTarget(el){if(!el)return null;var t=el.localName;'
  + 'if(svgA(el))return svgHref(el);'
  + 'if(t==="a"||t==="area")return el.getAttribute("href");'
  + 'var sub=t==="button"?el.type==="submit":t==="input"&&(el.type==="submit"||el.type==="image");'
  + 'if(!sub||!el.form)return null;'
  + 'return el.hasAttribute("formaction")?el.getAttribute("formaction"):el.form.getAttribute("action");}'
  + 'document.addEventListener("click",function(e){'
  + 'var el=e.target?activated(e.target):null;'
  + 'var c=jsCode(jsTarget(el));if(c===null)return;e.preventDefault();'
  + 'var s=document.createElement("script");s.textContent=c;(document.body||document.documentElement).appendChild(s);s.remove();'
  + '},true);';

/** Runs first in the frame: hvwa() and the dialogs show a banner (as text); javascript: links run (JS_LINKS). */
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
    + JS_LINKS
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
