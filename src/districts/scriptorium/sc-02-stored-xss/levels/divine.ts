import { parseFragment } from 'parse5';
import { escapeHtml } from '../../../../core/render.js';

// DIVINE — secure reference: the review is PARSED the way a browser parses it (parse5, the HTML5 tree builder), and a
// new fragment is written from that tree. Only the formatting tags on the allowlist come out, and bare: no attribute
// at all, so no handler and no URL. Every piece of text is escaped. Anything else (scripts, SVG and MathML, frames,
// links, comments) is dropped, and the text inside a dropped element survives as escaped text. The output is built,
// never copied from the input, so nothing the player wrote is read as markup, and re-reading the output gives the same
// output. Never sanitize HTML with a pattern over the text (Templar's and Inquisitor's lesson). Out of scope: links
// and images in reviews (none are allowed here); moderation and rate limits.
const ALLOWED: ReadonlySet<string> = new Set(['b', 'i', 'em', 'strong', 'p', 'br', 'blockquote']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** The parts of a parse5 node the writer reads. */
interface TreeNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly namespaceURI?: string;
  readonly value?: string;
  readonly childNodes?: readonly TreeNode[];
  readonly content?: { readonly childNodes: readonly TreeNode[] };
}

function write(nodes: readonly TreeNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.nodeName === '#text') out += escapeHtml(n.value ?? '');
    else if (n.tagName !== undefined) {
      const inner = write(n.content?.childNodes ?? n.childNodes ?? []);
      if (n.namespaceURI !== HTML_NS || !ALLOWED.has(n.tagName)) out += inner; // dropped, its text kept
      else if (n.tagName === 'br') out += '<br>';
      else out += `<${n.tagName}>${inner}</${n.tagName}>`;
    } // comments and doctypes: dropped
  }
  return out;
}

export function renderReview(body: string): string {
  return write(parseFragment(body).childNodes as readonly TreeNode[]);
}
