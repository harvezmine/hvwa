// src/core/xss/rules.ts — the sink rules table: which element, attribute or URL a current browser (Chromium, Firefox)
// would run as script. Bounded and enumerable on purpose; every row is pinned in tests/xss.spec.ts ("the sink matrix").
// Rules read parse5 elements (namespace, tag name, attributes as the tree builder left them: entities decoded, HTML
// names lower-cased, SVG names adjusted). Nothing here runs or parses JavaScript.
import type { DefaultTreeAdapterTypes } from 'parse5';
import { XSS_LIMITS } from './limits.js';
import { NS } from './ns.js';
import { readXml } from './xml.js';

export { NS };

type Element = DefaultTreeAdapterTypes.Element;

/** How a sink fires: by itself while the page loads, or when the victim acts on the page (click, hover, focus...). */
export type Trigger = 'load' | 'interaction';

/** An attribute in no namespace (an HTML attribute, or a plain SVG one such as `href`). */
export function attr(el: Element, name: string): string | undefined {
  for (const a of el.attrs) if (a.name === name && a.namespace === undefined) return a.value;
  return undefined;
}
/** `href`, or else SVG's legacy `xlink:href`. */
export function hrefOf(el: Element): { readonly name: string; readonly value: string } | undefined {
  for (const a of el.attrs) if (a.name === 'href' && a.namespace === undefined) return { name: 'href', value: a.value };
  for (const a of el.attrs) if (a.name === 'href' && a.namespace === NS.XLINK) return { name: 'xlink:href', value: a.value };
  return undefined;
}
const has = (el: Element, name: string): boolean => attr(el, name) !== undefined;
const isHtml = (el: Element, ...tags: string[]): boolean => el.namespaceURI === NS.HTML && tags.includes(el.tagName);
const isSvg = (el: Element, ...tags: string[]): boolean => el.namespaceURI === NS.SVG && tags.includes(el.tagName);

/** An element as a sink detail shows it: `img`, `svg:script`, `math:mtext`. */
export function label(el: Element): string {
  if (el.namespaceURI === NS.SVG) return `svg:${el.tagName}`;
  if (el.namespaceURI === NS.MATHML) return `math:${el.tagName}`;
  return el.tagName;
}

// --- Event handler content attributes ------------------------------------------------------------------------------
// HTML's GlobalEventHandlers and DocumentAndElementEventHandlers, the SVG animation events, and the vendor-prefixed and
// newer ones Chromium and Firefox support. An attribute not in these lists (`onfoo`, `data-onload`) is inert.

/** Events any element can get from the victim's input or a page's CSS. */
const UI_EVENTS: ReadonlySet<string> = new Set([
  'onauxclick', 'onbeforeinput', 'onbeforematch', 'onbeforetoggle', 'oncancel', 'onchange', 'onclick', 'onclose', 'oncommand',
  'oncontextlost', 'oncontextmenu', 'oncontextrestored', 'oncopy', 'oncuechange', 'oncut', 'ondblclick', 'ondrag', 'ondragend',
  'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop', 'onformdata', 'oninput', 'oninvalid', 'onkeydown',
  'onkeypress', 'onkeyup', 'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover',
  'onmouseup', 'onmousewheel', 'onpaste', 'onreset', 'onscroll', 'onscrollend', 'onscrollsnapchange', 'onscrollsnapchanging',
  'onsecuritypolicyviolation', 'onselect', 'onselectionchange', 'onselectstart', 'onslotchange', 'onsubmit', 'onwheel',
  'onpointerdown', 'onpointerup', 'onpointermove', 'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
  'onpointercancel', 'onpointerrawupdate', 'ongotpointercapture', 'onlostpointercapture', 'ontouchstart', 'ontouchend',
  'ontouchmove', 'ontouchcancel', 'ontransitionstart', 'ontransitionend', 'ontransitionrun', 'ontransitioncancel',
  'onwebkittransitionend', 'onfullscreenchange', 'onfullscreenerror', 'onwebkitfullscreenchange', 'onwebkitfullscreenerror',
  'onsearch', 'onbeforecopy', 'onbeforecut', 'onbeforepaste', 'onbeforexrselect',
]);
/**
 * CSS animation events: they fire by themselves when the page's own CSS animates the element (an inline animation
 * and a @keyframes rule on the page); otherwise only after the victim's interaction (a :hover rule, say).
 */
const ANIMATION_EVENTS: ReadonlySet<string> = new Set([
  'onanimationstart', 'onanimationend', 'onanimationiteration', 'onanimationcancel', 'onwebkitanimationstart',
  'onwebkitanimationend', 'onwebkitanimationiteration',
]);
/** Focus events: only an element that can take focus gets them. */
const FOCUS_EVENTS: ReadonlySet<string> = new Set(['onfocus', 'onblur', 'onfocusin', 'onfocusout']);
/** Media events: only video and audio fire them. */
const MEDIA_EVENTS: ReadonlySet<string> = new Set([
  'onabort', 'oncanplay', 'oncanplaythrough', 'ondurationchange', 'onemptied', 'onended', 'onloadeddata', 'onloadedmetadata',
  'onloadstart', 'onpause', 'onplay', 'onplaying', 'onprogress', 'onratechange', 'onseeked', 'onseeking', 'onstalled',
  'onsuspend', 'ontimeupdate', 'onvolumechange', 'onwaiting',
]);
/** Window events: only body and frameset forward them to the window; on any other element they never fire. */
const WINDOW_EVENTS: ReadonlySet<string> = new Set([
  'onafterprint', 'onbeforeprint', 'onbeforeunload', 'onhashchange', 'onlanguagechange', 'onmessage', 'onmessageerror',
  'onoffline', 'ononline', 'onpagehide', 'onpagereveal', 'onpageshow', 'onpageswap', 'onpopstate', 'onrejectionhandled',
  'onresize', 'onstorage', 'onunhandledrejection', 'onunload',
]);
/** SVG animation (SMIL) events: an animation element fires them on its own timeline. */
const SMIL_EVENTS: ReadonlySet<string> = new Set(['onbegin', 'onend', 'onrepeat']);
const SMIL_ELEMENTS: ReadonlySet<string> = new Set(['animate', 'animateMotion', 'animateTransform', 'animateColor', 'set', 'discard']);

/** Every event handler attribute the rules know (lower case). */
export const EVENT_HANDLERS: ReadonlySet<string> = new Set([
  ...UI_EVENTS, ...ANIMATION_EVENTS, ...FOCUS_EVENTS, ...MEDIA_EVENTS, ...WINDOW_EVENTS, ...SMIL_EVENTS, 'onload', 'onerror',
  'ontoggle', 'oncontentvisibilityautostatechange',
]);

/** What a handler's trigger depends on beyond its element: the document it is in. */
export interface PageFacts {
  /** Script elements run (false for markup inserted by innerHTML: its scripts are never fetched either). */
  readonly scriptElements: boolean;
  /** The page has a @keyframes rule (so an inline animation runs by itself). */
  readonly keyframes: boolean;
  /**
   * Whether a source loads, per element kind and URL, shared by every walk of one oracle call: a data: image is decoded
   * once, not once per handler (onload, onerror) and per walk (the page, the select pass, the round trips).
   */
  readonly loads?: Map<string, boolean | undefined>;
}

/** `<` followed by a letter, `!`, `/` or `?`: every tag, comment or doctype starts with one (an upper bound on tokens). */
export function tagOpens(s: string): number {
  let n = 0;
  for (let i = s.indexOf('<'); i !== -1 && i < s.length - 1; i = s.indexOf('<', i + 1)) {
    const c = s.charCodeAt(i + 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 33 || c === 47 || c === 63) n++;
  }
  return n;
}

/** A link's rel tokens, lower case. */
const rels = (el: Element): ReadonlySet<string> => new Set((attr(el, 'rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/));

/**
 * The URL an element fetches by itself, so its error (or, if it loads, its load) event fires on its own; undefined
 * when it fetches nothing. Checked against Chromium 157: a script inserted by innerHTML is never fetched (`scripts`
 * false); a link fetches as a stylesheet, a preload with an `as`, a modulepreload or a prefetch (an icon, a bare
 * preload: no event); a track only when it is the default one of a video or audio; an embed and an iframe fire no
 * error event.
 */
function sourceOf(el: Element, scripts: boolean): string | undefined {
  if (el.namespaceURI === NS.SVG) {
    if (isSvg(el, 'image', 'feImage') || (scripts && isSvg(el, 'script'))) return hrefOf(el)?.value;
    return undefined;
  }
  if (el.namespaceURI !== NS.HTML) return undefined;
  switch (el.tagName) {
    case 'img': case 'source': {
      const src = attr(el, 'src');
      if (src !== undefined) return src;
      const srcset = attr(el, 'srcset');
      return srcset === undefined ? undefined : trimAsciiWhitespace(srcset.split(',')[0] ?? '').split(/[\t\n\f\r ]+/)[0];
    }
    case 'input': return (attr(el, 'type') ?? '').trim().toLowerCase() === 'image' ? attr(el, 'src') : undefined;
    case 'video': case 'audio': return attr(el, 'src');
    case 'track': { // the default track of a media element (Chrome 157: no fetch for a track outside video or audio)
      const media = el.parentNode !== null && 'tagName' in el.parentNode && isHtml(el.parentNode, 'video', 'audio');
      return media && has(el, 'default') ? attr(el, 'src') : undefined;
    }
    case 'script': return scripts ? attr(el, 'src') : undefined;
    case 'link': {
      const r = rels(el);
      const fetches = r.has('stylesheet') || r.has('modulepreload') || r.has('prefetch') || (r.has('preload') && (attr(el, 'as') ?? '') !== '');
      return fetches ? attr(el, 'href') : undefined;
    }
    case 'object': return attr(el, 'data');
    default: return undefined;
  }
}
/** Elements whose load event fires when their source loads (media elements have no load event). */
const LOADING_ELEMENTS: ReadonlySet<string> = new Set(['img', 'input', 'script', 'link', 'object', 'track', 'svg:image', 'svg:script', 'svg:feImage']);
const IMAGE_ELEMENTS: ReadonlySet<string> = new Set(['img', 'input', 'source', 'svg:image', 'svg:feImage']);

// Minimal structural checks of the raster formats, as Chrome 157 judged decodes (headers and block structure; the
// compressed pixel data itself is not decoded): a GIF needs one complete image (its trailer may be missing); a PNG an
// IHDR first and one complete IDAT (IEND may be missing); a JPEG a frame header and the start of a scan (EOI may be
// missing); a WebP its RIFF size and a VP8 chunk. Garbage behind a valid signature errors.

function gifDecodes(b: Uint8Array): boolean {
  const n = b.length;
  if (n < 13 || (b[6] | (b[7] << 8)) === 0 || (b[8] | (b[9] << 8)) === 0) return false;
  let i = 13 + ((b[10] & 0x80) !== 0 ? 3 * (1 << ((b[10] & 7) + 1)) : 0); // the global color table
  const subBlocks = (at: number): number => { // the index after a run of data sub-blocks, or -1 if it is cut
    for (let k = at; k < n;) { const size = b[k]; k += 1 + size; if (size === 0) return k; }
    return -1;
  };
  let images = 0;
  while (i < n && b[i] !== 0x3b) { // the trailer
    if (b[i] === 0x21 && i + 1 < n) { // an extension: its label, then sub-blocks
      i = subBlocks(i + 2);
    } else if (b[i] === 0x2c && i + 10 < n) { // an image: descriptor, local color table, LZW code size, sub-blocks
      i += 10 + ((b[i + 9] & 0x80) !== 0 ? 3 * (1 << ((b[i + 9] & 7) + 1)) : 0);
      if (i >= n || b[i] < 1 || b[i] > 11) return images > 0;
      i = subBlocks(i + 1);
      if (i !== -1) images++;
    } else {
      return images > 0;
    }
    if (i === -1) return images > 0;
  }
  return images > 0;
}

function pngDecodes(b: Uint8Array): boolean {
  const n = b.length;
  const u32 = (at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  const type = (at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  if (n < 33 || u32(8) !== 13 || type(12) !== 'IHDR' || u32(16) === 0 || u32(20) === 0) return false;
  let idat = false;
  for (let i = 33; i + 12 <= n;) {
    const len = u32(i);
    if (i + 12 + len > n) break; // a cut chunk
    const t = type(i + 4);
    if (t === 'IDAT') idat = true;
    if (t === 'IEND') break;
    i += 12 + len;
  }
  return idat;
}

function jpegDecodes(b: Uint8Array): boolean {
  const n = b.length;
  let frame = false;
  for (let i = 2; i + 1 < n;) {
    if (b[i] !== 0xff) return false;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill bytes
    if (m === 0xd9) return false; // EOI before any scan
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    if (m < 0xc0 || i + 3 >= n) return false; // not a marker this decoder knows
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return false;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // a frame header (SOFn): height and width
      if (len < 8 || i + 8 >= n || ((b[i + 5] << 8) | b[i + 6]) === 0 || ((b[i + 7] << 8) | b[i + 8]) === 0) return false;
      frame = true;
    }
    if (m === 0xda) return frame && i + 2 + len <= n; // the start of a scan: enough to show (EOI may be missing)
    i += 2 + len;
  }
  return false;
}

function webpDecodes(b: Uint8Array): boolean {
  const n = b.length;
  const ascii = (at: number, s: string): boolean => [...s].every((c, k) => b[at + k] === c.charCodeAt(0));
  return n >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP') && (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) + 8 === n
    && (ascii(12, 'VP8 ') || ascii(12, 'VP8L') || ascii(12, 'VP8X'));
}

/**
 * Whether image bytes decode: a GIF, PNG, JPEG or WebP by the structural checks above, or a well-formed SVG document
 * (a broken one errors).
 * Undefined: not judged (an SVG over the oracle's size or tag cap, a tree over its caps, a DTD): neither its load nor
 * its error event counts.
 */
function imageLoads(d: { readonly mime: string; readonly text: string; readonly bytes: Uint8Array }): boolean | undefined {
  const b = d.bytes;
  const ascii = (at: number, s: string): boolean => [...s].every((c, k) => b[at + k] === c.charCodeAt(0));
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return gifDecodes(b);
  if (b[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return pngDecodes(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegDecodes(b);
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return webpDecodes(b);
  if (d.mime === 'image/svg+xml') {
    if (d.text.length > XSS_LIMITS.htmlLength || tagOpens(d.text) > XSS_LIMITS.tags) return undefined;
    const read = readXml(d.text);
    if (read.limited !== undefined) return undefined;
    const root = read.document.childNodes.find((c): c is Element => 'tagName' in c);
    return read.wellFormed && root !== undefined && root.namespaceURI === NS.SVG && root.tagName === 'svg';
  }
  return false;
}

/**
 * Whether a source loads (so onload fires and onerror does not). In the simulation only a data: URL can: every other
 * fetch fails (the citadel answers 404 for `src=x`, attacker.test serves nothing). A data: image must decode; a
 * script runs; a style sheet must be CSS; an object must be a document or an image; media is never judged playable.
 * Undefined: not judged (imageLoads). Cached in `page.loads` for the rest of the oracle call.
 */
function sourceLoads(el: Element, src: string, page: PageFacts): boolean | undefined {
  const url = urlText(src);
  if (schemeOf(url) !== 'data') return false;
  const name = label(el);
  const key = `${name}\n${url}`;
  if (page.loads?.has(key) === true) return page.loads.get(key);
  const d = dataUrl(url);
  let loads: boolean | undefined = false;
  if (d === undefined) loads = false;
  else if (IMAGE_ELEMENTS.has(name)) loads = imageLoads(d);
  else if (name === 'script' || name === 'svg:script') loads = true;
  else if (name === 'link') loads = d.mime === 'text/css';
  else if (name === 'object') loads = DOCUMENT_MIME_TYPES.has(d.mime) || imageLoads(d) === true;
  else if (name === 'track') loads = d.text.startsWith('WEBVTT');
  page.loads?.set(key, loads);
  return loads;
}

/** Whether the victim can focus the element (by clicking or tabbing to it). */
function focusable(el: Element): boolean {
  if (has(el, 'tabindex')) return true;
  const editable = attr(el, 'contenteditable');
  if (editable !== undefined && editable.trim().toLowerCase() !== 'false') return true;
  if (el.namespaceURI === NS.SVG) return isSvg(el, 'a') && hrefOf(el) !== undefined;
  if (el.namespaceURI !== NS.HTML) return false;
  switch (el.tagName) {
    case 'a': case 'area': return has(el, 'href');
    case 'input': return (attr(el, 'type') ?? '').trim().toLowerCase() !== 'hidden';
    case 'button': case 'select': case 'textarea': case 'iframe': case 'summary': return true;
    case 'audio': case 'video': return has(el, 'controls');
    default: return false;
  }
}

/**
 * How an event handler attribute on `el` fires: 'load' (by itself, as the page loads), 'interaction' (when the victim
 * clicks, hovers, focuses, scrolls...) or undefined (never: an unknown name, or an event this element never gets).
 * `name` is the attribute name, lower case; `page` says what the document allows (scripts, a @keyframes rule).
 */
export function handlerTrigger(el: Element, name: string, page: PageFacts): Trigger | undefined {
  const scripts = page.scriptElements;
  if (!EVENT_HANDLERS.has(name)) return undefined;
  const windowish = isHtml(el, 'body', 'frameset');
  if (WINDOW_EVENTS.has(name)) {
    if (!windowish) return undefined;
    return name === 'onpageshow' || name === 'onpagereveal' ? 'load' : 'interaction';
  }
  if (name === 'onload') {
    // The page's own load; a frame's (about:blank at least); an inline style sheet; an SVG element that is an <svg>
    // (not its children); and an element whose source loads (sourceLoads: only a data: URL that decodes).
    if (windowish || isHtml(el, 'iframe', 'frame', 'style') || isSvg(el, 'svg')) return 'load';
    const src = sourceOf(el, scripts);
    return src !== undefined && LOADING_ELEMENTS.has(label(el)) && sourceLoads(el, src, page) === true ? 'load' : undefined;
  }
  if (name === 'onerror') {
    const src = sourceOf(el, scripts);
    if (src !== undefined) return sourceLoads(el, src, page) === false ? 'load' : undefined; // `src=x` fails by itself; a valid data: image does not
    return windowish ? 'interaction' : undefined; // window.onerror needs some other script to fail
  }
  if (ANIMATION_EVENTS.has(name)) return page.keyframes && /animation/i.test(attr(el, 'style') ?? '') ? 'load' : 'interaction';
  if (name === 'oncontentvisibilityautostatechange') {
    return /content-visibility\s*:\s*auto/i.test(attr(el, 'style') ?? '') ? 'load' : 'interaction';
  }
  if (FOCUS_EVENTS.has(name)) {
    if (windowish) return 'interaction';
    if (!focusable(el)) return undefined;
    return (name === 'onfocus' || name === 'onfocusin') && has(el, 'autofocus') ? 'load' : 'interaction';
  }
  if (SMIL_EVENTS.has(name)) return el.namespaceURI === NS.SVG && SMIL_ELEMENTS.has(el.tagName) ? 'load' : undefined;
  if (MEDIA_EVENTS.has(name)) {
    if (!isHtml(el, 'video', 'audio')) return undefined;
    return name === 'onloadstart' && has(el, 'src') ? 'load' : 'interaction';
  }
  if (name === 'ontoggle') {
    if (isHtml(el, 'details')) return has(el, 'open') ? 'load' : 'interaction';
    return has(el, 'popover') ? 'interaction' : undefined;
  }
  return 'interaction';
}

// --- Script elements ------------------------------------------------------------------------------------------------

/** The JavaScript MIME type essences (HTML: "JavaScript MIME type essence match"). */
export const JS_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

/** What a script element is, from its type (and legacy language) attribute: a classic script, a module, or data. */
export function scriptKind(el: Element): 'classic' | 'module' | undefined {
  const type = attr(el, 'type');
  const language = attr(el, 'language');
  let kind: 'classic' | 'module' | undefined;
  if (type === undefined ? language === undefined || language === '' : type === '') kind = 'classic';
  else if (type === undefined) kind = JS_MIME_TYPES.has(`text/${(language ?? '').toLowerCase()}`) ? 'classic' : undefined;
  else {
    const t = trimAsciiWhitespace(type).toLowerCase();
    kind = JS_MIME_TYPES.has(t) ? 'classic' : t === 'module' ? 'module' : undefined; // importmap, text/plain ...: data
  }
  // A browser that runs modules skips a classic script marked nomodule (every current browser does).
  if (kind === 'classic' && el.namespaceURI === NS.HTML && has(el, 'nomodule')) return undefined;
  return kind;
}

/**
 * Whether a `data:` script with this MIME type runs: a module needs a JavaScript MIME type; a classic script runs
 * whatever the type says (measured in Chromium: even `data:image/png,...`).
 */
export function scriptMimeRuns(mime: string, kind: 'classic' | 'module'): boolean {
  return kind === 'classic' || JS_MIME_TYPES.has(mime);
}

// --- URLs -----------------------------------------------------------------------------------------------------------

// Trims are index loops, never a regex: `/^\s+|\s+$/` backtracks over every run of spaces that is not at the end, so it
// is quadratic on a long run inside an attacker's attribute (tests/xss.spec.ts, "stays linear").

/** `s` without leading and trailing ASCII whitespace (tab, LF, FF, CR, space), in linear time. */
export function trimAsciiWhitespace(s: string): string {
  const ws = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
  let start = 0;
  let end = s.length;
  while (start < end && ws(s.charCodeAt(start))) start++;
  while (end > start && ws(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** An attribute's URL as the URL parser reads it: leading and trailing C0 controls and spaces stripped, tabs and newlines removed. */
export function urlText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  const s = start === 0 && end === value.length ? value : value.slice(start, end);
  return /[\t\n\r]/.test(s) ? s.replace(/[\t\n\r]/g, '') : s;
}

/** A URL's scheme, lower case ('javascript', 'data', 'http' ...), or undefined for a relative URL. */
export function schemeOf(url: string): string | undefined {
  return /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(url)?.[1].toLowerCase();
}

function percentDecode(s: string): string {
  return new TextDecoder().decode(percentDecodeBytes(s));
}

function percentDecodeBytes(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length);
  const hex = (b: number): number => (b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x25 && i + 2 < bytes.length && hex(bytes[i + 1]) >= 0 && hex(bytes[i + 2]) >= 0) {
      out[n++] = hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]);
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

/** The code a `javascript:` URL runs: everything after the scheme, percent-decoded (HTML's javascript: URL rule). */
export function javascriptSource(url: string): string {
  return percentDecode(url.slice(url.indexOf(':') + 1));
}

/** A `data:` URL's MIME type, bytes and text (percent-decoded, base64-decoded when marked), or undefined when malformed. */
export function dataUrl(url: string): { readonly mime: string; readonly text: string; readonly bytes: Uint8Array } | undefined {
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const meta = url.slice(url.indexOf(':') + 1, comma);
  const base64 = /;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.test(meta);
  const mime = (base64 ? meta.replace(/;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i, '') : meta).split(';')[0].trim().toLowerCase() || 'text/plain';
  const raw = percentDecodeBytes(url.slice(comma + 1));
  if (!base64) return { mime, text: new TextDecoder().decode(raw), bytes: raw };
  try {
    const binary = atob(new TextDecoder().decode(raw).replace(/[\t\n\f\r ]/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return { mime, text: new TextDecoder().decode(bytes), bytes };
  } catch {
    return undefined; // not base64: the fetch fails, nothing runs
  }
}

/** MIME types a frame renders as a document that can run script. */
export const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
]);

/**
 * One attribute that navigates (or loads a nested document) to a URL: a `javascript:` URL there runs in the page.
 * `frame`: it loads a nested document, so a `data:` document there runs too, in an opaque (isolated) origin.
 */
export interface NavRule { readonly attribute: string; readonly trigger: Trigger; readonly frame: boolean; readonly javascript: boolean }

const NAV_HTML: Readonly<Record<string, readonly NavRule[]>> = Object.freeze({
  a: [{ attribute: 'href', trigger: 'interaction', frame: false, javascript: true }],
  area: [{ attribute: 'href', trigger: 'interaction', frame: false, javascript: true }],
  form: [{ attribute: 'action', trigger: 'interaction', frame: false, javascript: true }],
  button: [{ attribute: 'formaction', trigger: 'interaction', frame: false, javascript: true }],
  input: [{ attribute: 'formaction', trigger: 'interaction', frame: false, javascript: true }],
  iframe: [{ attribute: 'src', trigger: 'load', frame: true, javascript: true }],
  frame: [{ attribute: 'src', trigger: 'load', frame: true, javascript: true }],
  object: [{ attribute: 'data', trigger: 'load', frame: true, javascript: false }],
  embed: [{ attribute: 'src', trigger: 'load', frame: true, javascript: false }],
});

/**
 * Whether a button or input submits a form, so its formaction navigates: a submit button (a button of any type but
 * button and reset; an input of type submit or image) with a form owner (an ancestor form, or a form= attribute).
 */
function submitsForm(el: Element): boolean {
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  if (el.tagName === 'button' ? type === 'button' || type === 'reset' : type !== 'submit' && type !== 'image') return false;
  if ((attr(el, 'form') ?? '') !== '') return true;
  for (let p = el.parentNode; p !== null && 'tagName' in p; p = p.parentNode) if (isHtml(p, 'form')) return true;
  return false;
}

/** The navigation attributes of an element, with their values: `[rule, attribute as shown, value]`. */
export function navAttributes(el: Element): readonly (readonly [NavRule, string, string])[] {
  if (el.namespaceURI === NS.SVG) {
    if (el.tagName !== 'a') return [];
    const href = hrefOf(el);
    return href === undefined ? [] : [[{ attribute: 'href', trigger: 'interaction', frame: false, javascript: true }, href.name, href.value]];
  }
  if (el.namespaceURI !== NS.HTML || !Object.hasOwn(NAV_HTML, el.tagName)) return [];
  if ((el.tagName === 'button' || el.tagName === 'input') && !submitsForm(el)) return []; // formaction needs a submit with a form
  const out: (readonly [NavRule, string, string])[] = [];
  for (const rule of NAV_HTML[el.tagName]) {
    const value = attr(el, rule.attribute);
    if (value !== undefined) out.push([rule, rule.attribute, value]);
  }
  return out;
}

// --- Declarative shadow DOM (Chrome 157 attaches it; parse5 8.0.1 keeps it an inert template) -----------------------

/** HTML's valid shadow host names (custom element names can host one too). */
const SHADOW_HOSTS: ReadonlySet<string> = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p',
  'section', 'span',
]);
const RESERVED_CUSTOM_NAMES: ReadonlySet<string> = new Set([
  'annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph',
]);

/** Whether an element can host a shadow root: one of HTML's valid shadow host names, or a custom element. */
export function canHostShadow(el: Element): boolean {
  if (el.namespaceURI !== NS.HTML) return false;
  if (SHADOW_HOSTS.has(el.tagName)) return true;
  const c = el.tagName.charCodeAt(0);
  return c >= 97 && c <= 122 && el.tagName.includes('-') && !RESERVED_CUSTOM_NAMES.has(el.tagName);
}

/** A `<template shadowrootmode>`'s mode as the parser reads it (ASCII case-insensitive), or undefined. */
export function shadowRootMode(el: Element): 'open' | 'closed' | undefined {
  if (el.namespaceURI !== NS.HTML || el.tagName !== 'template') return undefined;
  const mode = (attr(el, 'shadowrootmode') ?? '').toLowerCase();
  return mode === 'open' || mode === 'closed' ? mode : undefined;
}

// --- SMIL animation of a link's href -------------------------------------------------------------------------------

/**
 * An SVG animate or set element that animates its target's `href` (Chrome 157 animates `href`, not `xlink:href`):
 * the URLs it would set (to, from, by, each of values) and its target, the id in `href="#id"` or undefined for its
 * parent. Undefined for any other element or attribute. The target must be an SVG `<a>` for a click to follow it.
 */
export function hrefAnimation(el: Element): { readonly target: string | undefined; readonly urls: readonly string[] } | undefined {
  if (!isSvg(el, 'animate', 'set') || attr(el, 'attributeName') !== 'href') return undefined;
  const urls: string[] = [];
  for (const name of ['to', 'from', 'by']) {
    const v = attr(el, name);
    if (v !== undefined) urls.push(v);
  }
  const values = attr(el, 'values');
  if (values !== undefined) urls.push(...values.split(';'));
  const href = hrefOf(el)?.value;
  if (href !== undefined && !href.startsWith('#')) return undefined; // a target in another document: nothing here
  return { target: href === undefined ? undefined : href.slice(1), urls };
}

/** A sandbox attribute (or a CSP `sandbox` directive's value): may scripts run, and keep the page's origin? */
export function sandboxOf(value: string): { readonly scripts: boolean; readonly sameOrigin: boolean } {
  const tokens = new Set(value.toLowerCase().split(/[\t\n\f\r ]+/).filter((t) => t !== ''));
  return { scripts: tokens.has('allow-scripts'), sameOrigin: tokens.has('allow-same-origin') };
}
