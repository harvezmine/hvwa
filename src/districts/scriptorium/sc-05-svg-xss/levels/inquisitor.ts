import type { Accepted, Review } from '../model.js';

// INQUISITOR — a real sanitizer with a gap, and a different way of serving. Before the sigil is stored, it refuses a
// DOCTYPE and cuts out every script element (with any prefix). Then, inside every start tag (comments, CDATA sections
// and processing instructions are read past whole, as an XML reader reads them, so a quote in them hides nothing), it
// removes every attribute named after one of HTML's event handlers (any case) and every srcdoc, and drops a
// javascript: URL from href, src, action and formaction (any prefix, xlink:href too), read as a browser reads it:
// character references undone, the ends trimmed, tabs and newlines removed. The review no longer pastes the sigil into
// an HTML page: it opens the file itself, served as the image it is (image/svg+xml, inline). But an SVG opened
// directly as image/svg+xml is a live XML document, not a picture, and the handler list below is HTML's: SVG has
// events of its own, and an animation of its own that can change an attribute after the sanitizer has looked at it.
const SCRIPT = /<(?:[^\s<>/!?:'"=]+:)?script\b[\s\S]*?(?:<\/(?:[^\s<>/:'"=]+:)?script\s*>|$)/gi;
/** A comment, a CDATA section, a processing instruction (each read past whole), or one start tag up to its `>`. */
const MARKUP = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<(?![\s/!?<>])(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^'">])*(?:>|$)/g;
/** One attribute inside a start tag: its name and its value as written (quoted or not). */
const ATTRIBUTE = /\s([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/g;
/** The attributes whose value is a URL a click or a load navigates to. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction']);
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The event handler attributes of HTML (GlobalEventHandlers, the window's, media, focus, pointer, CSS events). */
const HTML_EVENT_HANDLERS: ReadonlySet<string> = new Set([
  'onabort', 'onafterprint', 'onanimationcancel', 'onanimationend', 'onanimationiteration', 'onanimationstart',
  'onauxclick', 'onbeforecopy', 'onbeforecut', 'onbeforeinput', 'onbeforematch', 'onbeforepaste', 'onbeforeprint',
  'onbeforetoggle', 'onbeforeunload', 'onbeforexrselect', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough',
  'onchange', 'onclick', 'onclose', 'oncommand', 'oncontentvisibilityautostatechange', 'oncontextlost', 'oncontextmenu',
  'oncontextrestored', 'oncopy', 'oncuechange', 'oncut', 'ondblclick', 'ondrag', 'ondragend', 'ondragenter',
  'ondragleave', 'ondragover', 'ondragstart', 'ondrop', 'ondurationchange', 'onemptied', 'onended', 'onerror', 'onfocus',
  'onfocusin', 'onfocusout', 'onformdata', 'onfullscreenchange', 'onfullscreenerror', 'ongotpointercapture',
  'onhashchange', 'oninput', 'oninvalid', 'onkeydown', 'onkeypress', 'onkeyup', 'onlanguagechange', 'onload',
  'onloadeddata', 'onloadedmetadata', 'onloadstart', 'onlostpointercapture', 'onmessage', 'onmessageerror',
  'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup', 'onmousewheel',
  'onoffline', 'ononline', 'onpagehide', 'onpagereveal', 'onpageshow', 'onpageswap', 'onpaste', 'onpause', 'onplay',
  'onplaying', 'onpointercancel', 'onpointerdown', 'onpointerenter', 'onpointerleave', 'onpointermove', 'onpointerout',
  'onpointerover', 'onpointerrawupdate', 'onpointerup', 'onpopstate', 'onprogress', 'onratechange',
  'onrejectionhandled', 'onreset', 'onresize', 'onscroll', 'onscrollend', 'onscrollsnapchange', 'onscrollsnapchanging',
  'onsearch', 'onsecuritypolicyviolation', 'onseeked', 'onseeking', 'onselect', 'onselectionchange', 'onselectstart',
  'onslotchange', 'onstalled', 'onstorage', 'onsubmit', 'onsuspend', 'ontimeupdate', 'ontoggle', 'ontouchcancel',
  'ontouchend', 'ontouchmove', 'ontouchstart', 'ontransitioncancel', 'ontransitionend', 'ontransitionrun',
  'ontransitionstart', 'onunhandledrejection', 'onunload', 'onvolumechange', 'onwaiting', 'onwebkitanimationend',
  'onwebkitanimationiteration', 'onwebkitanimationstart', 'onwebkitfullscreenchange', 'onwebkitfullscreenerror',
  'onwebkittransitionend', 'onwheel',
]);

/** Whether an attribute value (as written, quotes included) is a javascript: URL once the XML reader and the URL parser are done with it. */
function isJavascriptUrl(written: string): boolean {
  const q = written[0];
  const inner = q === '"' || q === "'" ? written.slice(1, written.length > 1 && written.endsWith(q) ? -1 : undefined) : written;
  const decoded = inner.replace(/&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (_m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return XML_ENTITIES[name];
    const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
  let a = 0;
  let b = decoded.length;
  while (a < b && decoded.charCodeAt(a) <= 0x20) a++;
  while (b > a && decoded.charCodeAt(b - 1) <= 0x20) b--;
  return /^javascript:/i.test(decoded.slice(a, b).replace(/[\t\n\r]/g, ''));
}

function stripAttribute(whole: string, name: string, value: string): string {
  const n = name.toLowerCase();
  const local = n.slice(n.lastIndexOf(':') + 1);
  if (HTML_EVENT_HANDLERS.has(n) || local === 'srcdoc') return '';
  if (URL_ATTRIBUTES.has(local) && isJavascriptUrl(value)) return '';
  return whole;
}

export function accept(svg: string): Accepted {
  if (/<!DOCTYPE/i.test(svg)) return { ok: false, text: 'A DOCTYPE is not accepted in a sigil.' };
  let out = svg;
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(SCRIPT, '');
  }
  out = out.replace(MARKUP, (m: string) => (m.startsWith('<!') || m.startsWith('<?') ? m : m.replace(ATTRIBUTE, stripAttribute)));
  return { ok: true, svg: out };
}

export function review(sigil: string): Review {
  return { headers: { 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'inline' }, body: sigil };
}
