// src/core/xss/rules.ts — the sink rules table: which element, attribute or URL a current browser (Chromium, Firefox)
// would run as script. Bounded and enumerable on purpose; every row is pinned in tests/xss.spec.ts ("the sink matrix").
// Rules read parse5 elements (namespace, tag name, attributes as the tree builder left them: entities decoded, HTML
// names lower-cased, SVG names adjusted). Nothing here runs or parses JavaScript.
import type { DefaultTreeAdapterTypes } from 'parse5';

type Element = DefaultTreeAdapterTypes.Element;

export const NS = Object.freeze({
  HTML: 'http://www.w3.org/1999/xhtml',
  SVG: 'http://www.w3.org/2000/svg',
  MATHML: 'http://www.w3.org/1998/Math/MathML',
  XLINK: 'http://www.w3.org/1999/xlink',
  XML: 'http://www.w3.org/XML/1998/namespace',
  XMLNS: 'http://www.w3.org/2000/xmlns/',
});

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
  'ontouchmove', 'ontouchcancel', 'onanimationstart', 'onanimationend', 'onanimationiteration', 'onanimationcancel',
  'ontransitionstart', 'ontransitionend', 'ontransitionrun', 'ontransitioncancel', 'onwebkitanimationstart',
  'onwebkitanimationend', 'onwebkitanimationiteration', 'onwebkittransitionend', 'oncontentvisibilityautostatechange',
  'onfullscreenchange', 'onfullscreenerror', 'onwebkitfullscreenchange', 'onwebkitfullscreenerror', 'onsearch',
  'onbeforecopy', 'onbeforecut', 'onbeforepaste',
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
  ...UI_EVENTS, ...FOCUS_EVENTS, ...MEDIA_EVENTS, ...WINDOW_EVENTS, ...SMIL_EVENTS, 'onload', 'onerror', 'ontoggle',
]);

/**
 * The URL an element fetches by itself, so its error (and, if it loads, load) event fires on its own; undefined when
 * it fetches nothing. A script element inserted by innerHTML is never fetched (`scripts` false). Checked against
 * Chromium: an icon link and an embed fire no error event, an iframe never does.
 */
function sourceOf(el: Element, scripts: boolean): string | undefined {
  if (el.namespaceURI === NS.SVG) {
    if (isSvg(el, 'image', 'feImage') || (scripts && isSvg(el, 'script'))) return hrefOf(el)?.value;
    return undefined;
  }
  if (el.namespaceURI !== NS.HTML) return undefined;
  switch (el.tagName) {
    case 'img': case 'source': return attr(el, 'src') ?? attr(el, 'srcset');
    case 'input': return (attr(el, 'type') ?? '').trim().toLowerCase() === 'image' ? attr(el, 'src') : undefined;
    case 'video': case 'audio': case 'track': return attr(el, 'src');
    case 'script': return scripts ? attr(el, 'src') : undefined;
    case 'link': return /(^|[\t\n\f\r ])stylesheet([\t\n\f\r ]|$)/i.test(attr(el, 'rel') ?? '') ? attr(el, 'href') : undefined;
    case 'object': return attr(el, 'data');
    default: return undefined;
  }
}
/** Elements whose load event fires when their source loads (media elements have no load event). */
const LOADING_ELEMENTS: ReadonlySet<string> = new Set(['img', 'input', 'script', 'link', 'object', 'track', 'svg:image', 'svg:script', 'svg:feImage']);

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
 * `name` is the attribute name, lower case; `scripts` is false for markup inserted by innerHTML (its scripts are
 * never fetched).
 */
export function handlerTrigger(el: Element, name: string, scripts: boolean): Trigger | undefined {
  if (!EVENT_HANDLERS.has(name)) return undefined;
  const windowish = isHtml(el, 'body', 'frameset');
  if (WINDOW_EVENTS.has(name)) {
    if (!windowish) return undefined;
    return name === 'onpageshow' || name === 'onpagereveal' ? 'load' : 'interaction';
  }
  if (name === 'onload') {
    // The page's own load; a frame's (about:blank at least); an inline style sheet; an SVG element that is an <svg>
    // (not its children); and an element whose source loads without the network: a data: URL. (In the simulation
    // every other fetch fails: the citadel answers 404 for `src=x`, attacker.test serves nothing.)
    if (windowish || isHtml(el, 'iframe', 'frame', 'style') || isSvg(el, 'svg')) return 'load';
    const src = sourceOf(el, scripts);
    return src !== undefined && LOADING_ELEMENTS.has(label(el)) && schemeOf(urlText(src)) === 'data' ? 'load' : undefined;
  }
  if (name === 'onerror') {
    if (sourceOf(el, scripts) !== undefined) return 'load'; // `src=x` fails by itself
    return windowish ? 'interaction' : undefined; // window.onerror needs some other script to fail
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
  return new TextDecoder().decode(out.subarray(0, n));
}

/** The code a `javascript:` URL runs: everything after the scheme, percent-decoded (HTML's javascript: URL rule). */
export function javascriptSource(url: string): string {
  return percentDecode(url.slice(url.indexOf(':') + 1));
}

/** A `data:` URL's MIME type and text (percent-decoded, base64-decoded when marked), or undefined when malformed. */
export function dataUrl(url: string): { readonly mime: string; readonly text: string } | undefined {
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const meta = url.slice(url.indexOf(':') + 1, comma);
  const base64 = /;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.test(meta);
  const mime = (base64 ? meta.replace(/;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i, '') : meta).split(';')[0].trim().toLowerCase() || 'text/plain';
  const body = percentDecode(url.slice(comma + 1));
  if (!base64) return { mime, text: body };
  try {
    const binary = atob(body.replace(/[\t\n\f\r ]/g, ''));
    return { mime, text: new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))) };
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

/** The navigation attributes of an element, with their values: `[rule, attribute as shown, value]`. */
export function navAttributes(el: Element): readonly (readonly [NavRule, string, string])[] {
  if (el.namespaceURI === NS.SVG) {
    if (el.tagName !== 'a') return [];
    const href = hrefOf(el);
    return href === undefined ? [] : [[{ attribute: 'href', trigger: 'interaction', frame: false, javascript: true }, href.name, href.value]];
  }
  if (el.namespaceURI !== NS.HTML || !Object.hasOwn(NAV_HTML, el.tagName)) return [];
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
