// INQUISITOR — real defense, subtly flawed: an allowlist. Every tag is matched by a pattern; a formatting tag on the
// list is kept BARE (all its attributes dropped), and every other tag is removed. One pass over the text, and the
// result is never read again. So removing a tag can join the text around it into a new tag that the pass has already
// gone by, attributes and all: the pattern saw pieces, and the browser reads what is left. The same holds the other
// way round: a tag the pattern cannot match because another tag starts inside it (<img src=x onerror=... <b>) is
// left as it is, and the browser reads it as one <img> with its handler. One flaw, two shapes: a pattern is no parser.
const ALLOWED: ReadonlySet<string> = new Set(['b', 'i', 'em', 'strong', 'p', 'br', 'blockquote']);

export function renderReview(body: string): string {
  return body.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)[^<>]*>/g, (_tag, close: string, name: string) => {
    const tag = name.toLowerCase();
    return ALLOWED.has(tag) ? `<${close}${tag}>` : '';
  });
}
