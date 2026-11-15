// src/core/render.ts — EJS page rendering and the source diff view.
import type { Response } from 'express';
import { renderFile, type Options } from 'ejs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { t, DEFAULT_LANG, type Lang } from './i18n.js';
import { diffLines } from './diff.js';

const here = dirname(fileURLToPath(import.meta.url));

// The shared page shell is engine-owned (core/views/layout.ejs), so core never
// reaches into portal/ or districts/.
const layoutFile = join(here, 'views', 'layout.ejs');

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// SECURITY: always pass this third argument to renderFile. With only
// (file, data), ejs reads options out of the data object itself
// (data.settings['view options'], delimiter, async, ...), so request-derived
// data could set client/escapeFunction and run code in the host process.
// A fresh object per call keeps ejs from mutating shared state.
function serverEjsOptions(): Options {
  return { async: false, strict: false, rmWhitespace: false };
}

/**
 * Data keys a view may not set: ejs's own template-function locals
 * (escapeFn, include, rethrow, __append, __output, locals) and the context
 * the engine provides (body for the layout; t and lang from res.locals).
 */
export const RESERVED_VIEW_KEYS: ReadonlySet<string> = new Set([
  'escapeFn', 'include', 'rethrow', '__append', '__output', 'locals', 'body', 't', 'lang',
]);

function assertViewFile(viewFile: string): void {
  if (!isAbsolute(viewFile)) throw new Error(`page(): view path must be absolute (got "${viewFile}")`);
  if (!viewFile.endsWith('.ejs')) throw new Error(`page(): view must be an .ejs file (got "${viewFile}")`);
}

function assertNoReservedKeys(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    if (RESERVED_VIEW_KEYS.has(key)) throw new Error(`page(): reserved data key "${key}"`);
  }
}

/**
 * Render an EJS view (absolute .ejs path) inside the shared layout and return
 * the HTML. Context = res.locals (lang, t, and on challenge routes level and
 * challenge) overlaid with `data`; reserved keys are rejected.
 */
export async function page(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<string> {
  assertViewFile(viewFile);
  assertNoReservedKeys(data);
  const ctx: Record<string, unknown> = { ...res.locals, ...data };
  const body = await renderFile(viewFile, ctx, serverEjsOptions());
  return renderFile(layoutFile, { ...ctx, body }, serverEjsOptions());
}

/**
 * Render with page() and send it as text/html. The usual call from a
 * challenge route: `await sendPage(res, view('login'), { message })`.
 */
export async function sendPage(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<void> {
  res.type('html').send(await page(res, viewFile, data));
}

/**
 * Two-column LCS line diff of vulnerable vs secure source (HTML-escaped),
 * used by every challenge's "View Source → compare Acolyte vs Divine" panel.
 * One-sided rows get an empty, unnumbered cell on the missing side.
 */
export function diffView(vulnSrc: string, secureSrc: string, lang: Lang = DEFAULT_LANG): string {
  let ln = 0;
  let rn = 0;
  const cell = (side: 'vuln' | 'secure', text: string | undefined, num: number) =>
    text === undefined
      ? `<td class="diff-ln"></td><td class="diff-${side} diff-empty"></td>`
      : `<td class="diff-ln">${num}</td><td class="diff-${side}"><pre>${escapeHtml(text)}</pre></td>`;
  const body = diffLines(vulnSrc, secureSrc).map((r) => {
    const leftText = r.kind === 'add' ? undefined : r.left;
    const rightText = r.kind === 'del' ? undefined : r.right;
    const left = cell('vuln', leftText, leftText === undefined ? 0 : ++ln);
    const right = cell('secure', rightText, rightText === undefined ? 0 : ++rn);
    return `<tr class="diff-${r.kind}">${left}${right}</tr>`;
  }).join('');
  return (
    '<table class="diff-view"><thead><tr>' +
    `<th colspan="2">${escapeHtml(t('diff.vulnerable', lang))}</th>` +
    `<th colspan="2">${escapeHtml(t('diff.secure', lang))}</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}
