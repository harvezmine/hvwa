// src/core/render.ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Absolute path to the portal's EJS views (used as an Express view root).
export const portalViewsDir = join(here, '..', 'portal', 'views');

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Two-column line diff of vulnerable vs secure source. Rendered by every
// challenge's "View Source → compare Acolyte vs Divine" panel.
export function diffView(vulnSrc: string, secureSrc: string): string {
  const a = vulnSrc.split('\n');
  const b = secureSrc.split('\n');
  const max = Math.max(a.length, b.length);
  const rows: string[] = [];
  for (let i = 0; i < max; i++) {
    const l = a[i] ?? '';
    const r = b[i] ?? '';
    const cls = l !== r ? ' class="diff-changed"' : '';
    rows.push(
      `<tr${cls}><td class="diff-ln">${i + 1}</td>` +
        `<td class="diff-vuln"><pre>${escapeHtml(l)}</pre></td>` +
        `<td class="diff-secure"><pre>${escapeHtml(r)}</pre></td></tr>`,
    );
  }
  return (
    '<table class="diff-view"><thead><tr><th></th>' +
    '<th>Acolyte (vulnerable)</th><th>Divine (secure)</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table>`
  );
}
