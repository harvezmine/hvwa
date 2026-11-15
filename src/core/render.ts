// src/core/render.ts — EJS page rendering and the source diff view.
import type { Response } from 'express';
import { renderFile, type Options } from 'ejs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { t, DEFAULT_LANG, type Lang } from './i18n.js';
import { LEVELS, type Level } from './levels.js';
import { diffLines } from './diff.js';
import { challengePath } from './mount.js';

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
 * the engine provides (body and labBar for the layout; t and lang from
 * res.locals; challenge and level from res.locals on challenge routes).
 */
export const RESERVED_VIEW_KEYS: ReadonlySet<string> = new Set([
  'escapeFn', 'include', 'rethrow', '__append', '__output', 'locals', 'body', 't', 'lang',
  'challenge', 'level', 'labBar',
]);

/** The layout's lab bar: player guidance shown above every challenge route's view. */
export interface LabBar {
  readonly id: string;
  readonly title: string;     // current lang
  readonly summary: string;   // current lang
  readonly level: Level;      // the clamped level being served
  readonly levelLabel: string;
  readonly pageTitle: string; // default <title>: "<id> — <title>"
  readonly backHref: string;  // the challenge page, /c/<id>
  /** One link per implemented level, rank order; Divine is labelled as the secure reference. */
  readonly levels: readonly { id: Level; href: string; label: string; current: boolean }[];
}

/** Lab bar for a challenge route (res.locals.challenge and .level are set by mountChallenges), else undefined. */
function labBar(locals: Response['locals']): LabBar | undefined {
  const { challenge: c, level } = locals;
  if (!c || !level) return undefined;
  const lang: Lang = locals.lang ?? DEFAULT_LANG;
  const title = c.title[lang];
  return {
    id: c.id, title, summary: c.summary[lang], level, levelLabel: t(`level.${level}`, lang),
    pageTitle: `${c.id} — ${title}`, backHref: `/c/${c.id}`,
    levels: LEVELS.filter((l) => c.levels.includes(l)).map((l) => ({
      id: l,
      href: `${challengePath(c)}?level=${l}`,
      label: t(l === 'divine' ? 'challenge.divine_tab' : `level.${l}`, lang),
      current: l === level,
    })),
  };
}

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
 * challenge) overlaid with `data`; reserved keys are rejected. On challenge
 * routes the layout also shows the lab bar.
 */
export async function page(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<string> {
  assertViewFile(viewFile);
  assertNoReservedKeys(data);
  const ctx: Record<string, unknown> = { ...res.locals, ...data };
  const body = await renderFile(viewFile, ctx, serverEjsOptions());
  return renderFile(layoutFile, { ...ctx, body, labBar: labBar(res.locals) }, serverEjsOptions());
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
export function diffView(
  vulnSrc: string, secureSrc: string, lang: Lang = DEFAULT_LANG, vulnLevel: Level = 'acolyte',
): string {
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
    `<th colspan="2">${escapeHtml(`${t('diff.vulnerable', lang)} (${t(`level.${vulnLevel}`, lang)})`)}</th>` +
    `<th colspan="2">${escapeHtml(t('diff.secure', lang))}</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}
