import { escapeHtml } from '../../../../core/render.js';
import type { MarkdownRules } from '../model.js';

// TEMPLAR — naive filter: notes may not contain HTML, so every tag is stripped out of the text, and what is left is
// escaped; every attribute value is escaped too. But Markdown makes its own markup: a link's target goes into href
// with no question asked about its SCHEME. A link is a link, whatever it points at.
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

export const rules: MarkdownRules = {
  text: (s) => escapeHtml(stripTags(s)),
  code: (s) => `<code>${escapeHtml(stripTags(s))}</code>`,
  link: (label, href) => `<a href="${escapeHtml(href)}">${escapeHtml(stripTags(label))}</a>`,
  image: (alt, src, title) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(stripTags(alt))}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>`,
};
