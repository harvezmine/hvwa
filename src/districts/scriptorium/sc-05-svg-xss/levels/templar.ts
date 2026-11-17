import type { Accepted, Review } from '../model.js';

// TEMPLAR — a tag filter. Before the sigil is stored, every <script> element is cut out of it: any case, a nested
// spelling too (the cut repeats until nothing changes), and an unclosed one up to the end. The review page still
// pastes the rest into its HTML as markup. Only one tag is blocked; everything else an SVG can do is kept.
const SCRIPT = /<script\b[\s\S]*?(?:<\/script\s*>|$)/gi;

export function accept(svg: string): Accepted {
  let out = svg;
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(SCRIPT, '');
  }
  return { ok: true, svg: out };
}

export function review(sigil: string): Review {
  return {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline' },
    body: `<h1>Sigil review</h1>\n<figure class="sigil">${sigil}</figure>`,
  };
}
