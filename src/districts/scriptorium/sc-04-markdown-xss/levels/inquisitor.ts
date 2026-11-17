import type { MarkdownRules } from '../model.js';

// INQUISITOR — real defense, subtly flawed: text is escaped (& < >), and a link or an image is drawn only when the
// browser would read its target as http, https (or mailto, for a link), checked with the same URL parser the browser
// uses. src, alt and href are attribute values, so their quotes are escaped too. The image TITLE, though, goes through
// the text escaper only: inside a quoted attribute, a quote in the title ends the attribute, and the rest of the
// title is read as more attributes of the <img>.
const BASE = 'http://citadel.test/note';
const LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;');

/** The scheme a browser would use for this URL on the note page ('' when it does not parse). */
function scheme(url: string): string {
  try {
    return new URL(url, BASE).protocol;
  } catch {
    return '';
  }
}

export const rules: MarkdownRules = {
  text: escapeText,
  code: (s) => `<code>${escapeText(s)}</code>`,
  link: (label, href) => (LINK_SCHEMES.has(scheme(href)) ? `<a href="${escapeAttr(href)}">${escapeText(label)}</a>` : escapeText(label)),
  image: (alt, src, title) => (!IMAGE_SCHEMES.has(scheme(src)) ? escapeText(alt)
    : `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${title === undefined ? '' : ` title="${escapeText(title)}"`}>`),
};
