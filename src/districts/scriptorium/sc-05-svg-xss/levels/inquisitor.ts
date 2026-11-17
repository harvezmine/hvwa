import type { Accepted, Review } from '../model.js';

// INQUISITOR — a real sanitizer with a gap, and a different way of serving. Before the sigil is stored, it refuses a
// DOCTYPE, cuts out every script element (prefixed ones too), removes every attribute named after one of HTML's event
// handlers (any case), and drops javascript: links. The review no longer pastes the sigil into an HTML page: it opens
// the file itself, served as the image it is (image/svg+xml, inline). But an SVG opened directly as image/svg+xml is
// a live XML document, not a picture, and the handler list below is HTML's: SVG has events of its own.
const SCRIPT = /<(?:[\w.-]+:)?script\b[\s\S]*?(?:<\/(?:[\w.-]+:)?script\s*>|$)/gi;
const ATTRIBUTE = /\s([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/g;
const JAVASCRIPT_LINK = /^["']?[\s\u0000-\u001f]*javascript:/i;

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

export function accept(svg: string): Accepted {
  if (/<!DOCTYPE/i.test(svg)) return { ok: false, text: 'A DOCTYPE is not accepted in a sigil.' };
  let out = svg;
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(SCRIPT, '');
  }
  out = out.replace(ATTRIBUTE, (whole: string, name: string, value: string) => {
    const n = name.toLowerCase();
    if (HTML_EVENT_HANDLERS.has(n)) return '';
    if ((n === 'href' || n.endsWith(':href')) && JAVASCRIPT_LINK.test(value)) return '';
    return whole;
  });
  return { ok: true, svg: out };
}

export function review(sigil: string): Review {
  return { headers: { 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'inline' }, body: sigil };
}
