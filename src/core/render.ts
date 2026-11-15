// src/core/render.ts
import type { Response } from 'express';
import { renderFile } from 'ejs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, DEFAULT_LANG, type Lang } from './i18n.js';

const here = dirname(fileURLToPath(import.meta.url));

// Absolute path to the portal's EJS views (holds the shared layout).
export const portalViewsDir = join(here, '..', 'portal', 'views');
const layoutFile = join(portalViewsDir, 'layout.ejs');

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render an EJS view (absolute path) and wrap it in the shared layout.
// Context = res.locals (lang, t from langMiddleware) overlaid with `data`.
// Exported for districts: page(res, join(myViewsDir, 'x.ejs'), { ... }).
export async function page(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<string> {
  const ctx: Record<string, unknown> = { ...res.locals, ...data };
  const body = await renderFile(viewFile, ctx);
  return renderFile(layoutFile, { ...ctx, body });
}

type Op = { kind: 'same' | 'del' | 'add'; text: string };

function splitLines(src: string): string[] {
  const lines = src.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Classic LCS over lines → sequence of same / del (vuln only) / add (secure only).
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: 'del', text: a[i++] });
    else ops.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

type Row = { kind: 'same' | 'del' | 'add' | 'changed'; left?: string; right?: string };

// Collapse each run of deletions/insertions into side-by-side rows: paired
// lines become one "changed" row, leftovers stay one-sided.
function toRows(ops: Op[]): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === 'same') { rows.push({ kind: 'same', left: ops[k].text, right: ops[k].text }); k++; continue; }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].kind !== 'same') {
      (ops[k].kind === 'del' ? dels : adds).push(ops[k].text);
      k++;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let p = 0; p < paired; p++) rows.push({ kind: 'changed', left: dels[p], right: adds[p] });
    for (const l of dels.slice(paired)) rows.push({ kind: 'del', left: l });
    for (const r of adds.slice(paired)) rows.push({ kind: 'add', right: r });
  }
  return rows;
}

// Two-column LCS line diff of vulnerable vs secure source, used by every
// challenge's "View Source → compare Acolyte vs Divine" panel.
export function diffView(vulnSrc: string, secureSrc: string, lang: Lang = DEFAULT_LANG): string {
  const rows = toRows(lineOps(splitLines(vulnSrc), splitLines(secureSrc)));
  let ln = 0;
  let rn = 0;
  const cell = (side: 'vuln' | 'secure', text: string | undefined, num: number) =>
    text === undefined
      ? `<td class="diff-ln"></td><td class="diff-${side} diff-empty"></td>`
      : `<td class="diff-ln">${num}</td><td class="diff-${side}"><pre>${escapeHtml(text)}</pre></td>`;
  const body = rows.map((r) => {
    const left = cell('vuln', r.left, r.left === undefined ? 0 : ++ln);
    const right = cell('secure', r.right, r.right === undefined ? 0 : ++rn);
    return `<tr class="diff-${r.kind}">${left}${right}</tr>`;
  }).join('');
  return (
    '<table class="diff-view"><thead><tr>' +
    `<th colspan="2">${escapeHtml(t('diff.vulnerable', lang))}</th>` +
    `<th colspan="2">${escapeHtml(t('diff.secure', lang))}</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}
