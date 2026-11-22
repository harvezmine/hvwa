// tests/support/contrast.ts — the design tokens of src/public/app.css and the WCAG contrast pairs the components use
// (tests/ui-contrast.spec.ts checks them; docs/UI.md lists them).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const css = readFileSync(fileURLToPath(new URL('../../src/public/app.css', import.meta.url)), 'utf8');

/** The custom properties declared in the first block that opens with `selector {`. */
export function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no block ${selector}`);
  const body = css.slice(at + selector.length + 2, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

export const dark = block(':root');
export const lightExplicit = block(':root[data-theme="light"]');
export const lightSystem = block(':root:not([data-theme="dark"])');
export const light = { ...dark, ...lightExplicit };

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--bg', '--surface', '--surface-2'];
const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
/** [foreground, background, minimum ratio] */
export const PAIRS: [string, string, number][] = [
  ...['--bg', '--surface', '--surface-2', '--surface-3', '--sunken'].map((bg): [string, string, number] => ['--text', bg, 4.5]),
  ...['--bg', '--surface', '--surface-2', '--surface-3', '--sunken'].map((bg): [string, string, number] => ['--text-muted', bg, 4.5]),
  ...SURFACES.map((bg): [string, string, number] => ['--link', bg, 4.5]),
  ...SURFACES.map((bg): [string, string, number] => ['--primary-text', bg, 4.5]),
  ['--on-primary', '--primary', 4.5], ['--on-primary', '--primary-hover', 4.5],
  ['--success', '--success-bg', 4.5], ['--success', '--surface', 4.5], ['--success', '--surface-2', 4.5], ['--success', '--bg', 4.5],
  ['--danger', '--danger-bg', 4.5], ['--danger', '--surface', 4.5], ['--danger', '--surface-2', 4.5],
  ['--warning', '--warning-bg', 4.5], ['--text', '--warning-bg', 4.5],
  ['--info', '--info-bg', 4.5], ['--text', '--info-bg', 4.5],
  ['--text', '--success-bg', 4.5], ['--text', '--danger-bg', 4.5],
  ['--banner-text', '--banner-bg', 4.5],
  ['--code-text', '--code-bg', 4.5], ['--text-faint', '--code-bg', 4.5],
  ['--code-text', '--diff-del-bg', 4.5], ['--code-text', '--diff-add-bg', 4.5],
  ...LEVELS.flatMap((l): [string, string, number][] => [
    [`--lv-${l}`, '--surface', 4.5], [`--lv-${l}`, '--surface-2', 4.5], [`--lv-${l}`, `--lv-${l}-bg`, 4.5],
    ['--on-level', `--lv-${l}`, 4.5],
  ]),
  // Non-text UI boundaries (WCAG 1.4.11): 3:1.
  ['--border-input', '--sunken', 3], ['--border-input', '--surface', 3], ['--border-input', '--surface-2', 3],
  ['--focus', '--bg', 3], ['--focus', '--surface', 3], ['--focus', '--surface-2', 3],
  // The Guild Ledger additions: text on the inverted slip, and the copper seal/hardware on paper.
  ['--on-inverted', '--inverted', 4.5],
  ['--copper', '--surface', 3], ['--copper', '--surface-2', 3], ['--copper', '--bg', 3],
];

