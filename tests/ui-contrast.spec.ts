// The design tokens (src/public/app.css, docs/UI.md): every text / background pair the components use meets WCAG AA
// (4.5:1) in BOTH themes, UI boundaries (input borders, the focus ring) meet 3:1, and the two copies of the light
// theme (explicit data-theme="light", and prefers-color-scheme: light) are identical.
import { describe, it, expect } from 'vitest';

import { css, dark, light, lightExplicit, lightSystem, contrast, PAIRS } from './support/contrast.js';

describe('design tokens (app.css)', () => {
  it('the light theme is declared twice, identically (data-theme="light" and prefers-color-scheme: light)', () => {
    expect(Object.keys(lightExplicit).length).toBeGreaterThan(30);
    expect(lightSystem).toEqual(lightExplicit);
  });

  it('every colour token of the dark theme is redefined by the light theme (except the theme-independent ones)', () => {
    const independent = new Set(['--frame-bg']);
    const colours = Object.entries(dark).filter(([k, v]) => /^#|^rgba?\(|^0 /.test(v) && !independent.has(k)).map(([k]) => k);
    expect(colours.filter((k) => !(k in lightExplicit))).toEqual([]);
  });

  it.each([['dark', dark], ['light', light]] as const)('%s theme: every text pair >= 4.5:1, every UI boundary >= 3:1', (_name, theme) => {
    const failing = PAIRS
      .map(([fg, bg, min]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(theme[fg], theme[bg]), min }))
      .filter((p) => p.ratio < p.min)
      .map((p) => `${p.pair}: ${p.ratio.toFixed(2)} < ${p.min}`);
    expect(failing).toEqual([]);
  });

  it('components use tokens: no raw colour outside the token blocks', () => {
    const tokenBlocks = /:root(?:\[data-theme="light"\]|:not\(\[data-theme="dark"\]\))?\s*\{[^}]*\}/g;
    const rest = css.replace(tokenBlocks, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rest.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
  });
});
