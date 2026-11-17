import type { MarkdownRules } from '../model.js';

// ACOLYTE — no defense: every piece of the note is written into the HTML as it is. Text keeps any HTML you typed (a
// Markdown renderer that "passes raw HTML through", as many do by default), and links and images take their target,
// alt text and title verbatim.
export const rules: MarkdownRules = {
  text: (s) => s,
  code: (s) => `<code>${s}</code>`,
  link: (label, href) => `<a href="${href}">${label}</a>`,
  image: (alt, src, title) => `<img src="${src}" alt="${alt}"${title === undefined ? '' : ` title="${title}"`}>`,
};
