import type { Accepted, Review } from '../model.js';

// ACOLYTE — no defense. The sigil is stored exactly as uploaded, and the review page pastes it into its own HTML as
// markup. An SVG inlined in an HTML page is live: anything active inside it (a script element, an event handler)
// runs in the moderator's browser, on the gallery's origin, with the moderator's session.
export function accept(svg: string): Accepted {
  return { ok: true, svg };
}

export function review(sigil: string): Review {
  return {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline' },
    body: `<h1>Sigil review</h1>\n<figure class="sigil">${sigil}</figure>`,
  };
}
