import { escapeHtml } from '../../../../core/render.js';
import type { MarkdownRules } from '../model.js';

// DIVINE — secure reference: Markdown is not a sanitizer, so the renderer escapes FIRST and decides every URL itself.
// Text, code, labels and every attribute value (src, alt, title, href) go through one escaper for & < > " '. A link's
// target is checked by the scheme the browser will use, read by the same WHATWG URL parser (so case, tabs, newlines
// and leading control characters are undone before the check): only http, https and mailto are links. An image comes
// only from http or https (or a relative path); a data: or javascript: image is not drawn. Whatever is refused stays
// as escaped text. Out of scope: there is no raw HTML at all in notes (nothing is allowed through, so no sanitizer is
// needed), and the page sends no CSP (it is not the fix).
const BASE = 'http://citadel.test/note';
const LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The scheme a browser would use for this URL on the note page ('' when it does not parse). */
function scheme(url: string): string {
  try {
    return new URL(url, BASE).protocol;
  } catch {
    return '';
  }
}

export const rules: MarkdownRules = {
  text: (s) => escapeHtml(s),
  code: (s) => `<code>${escapeHtml(s)}</code>`,
  link: (label, href) => (LINK_SCHEMES.has(scheme(href)) ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label)),
  image: (alt, src, title) => (!IMAGE_SCHEMES.has(scheme(src)) ? escapeHtml(alt)
    : `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>`),
};
