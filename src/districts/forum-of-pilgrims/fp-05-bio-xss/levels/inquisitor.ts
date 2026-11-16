import { escapeHtml } from '../../../../core/render.js';

// INQUISITOR — real defense, subtly flawed: the whole bio is escaped (& < > " '), and the bio is no longer put in any
// attribute. Then three formatting tags are let back in: <b>, <i> and <a href="...">, matched exactly, so no tag
// comes back with any other attribute. A link is refused when its href starts with "javascript:" (trimmed,
// lower-cased). That check reads the href as WRITTEN. The browser reads it as a URL: it drops every tab and newline
// anywhere in it and any control character in front, and only then looks at the scheme.
const isScript = (href: string): boolean => href.trim().toLowerCase().startsWith('javascript:');

export function renderBio(bio: string): string {
  const html = escapeHtml(bio)
    .replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>')
    .replace(/&lt;\/a&gt;/g, '</a>')
    .replace(/&lt;a href=&quot;([\s\S]*?)&quot;&gt;/g, (tag: string, href: string) => (isScript(href) ? tag : `<a href="${href}">`));
  return `<div class="bio">${html}</div>`;
}
