// TEMPLAR — naive filter: & < > are escaped, so the bio can open no tag. The card shows the first 80 characters, and
// the whole bio as a hover tooltip, in a title attribute built by string concatenation. Escaping & < > is enough for
// text between tags; inside a quoted attribute value it is not: a quote in the bio ends the value, and what follows
// is read as more attributes of the card, an event handler included.
const SHORT = 80;
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderBio(bio: string): string {
  const shown = bio.length > SHORT ? `${bio.slice(0, SHORT)}…` : bio;
  return `<div class="bio" title="${escapeText(bio)}">${escapeText(shown)}</div>`;
}
