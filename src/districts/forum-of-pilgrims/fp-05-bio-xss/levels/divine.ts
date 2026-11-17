import { parseFragment } from 'parse5';
import { escapeHtml } from '../../../../core/render.js';

// DIVINE — secure reference: the bio is PARSED the way a browser parses it (parse5, the HTML5 tree builder), and a new
// fragment is written from that tree, from an allowlist of tags AND attributes. <b> and <i> come out bare. <a> keeps
// one attribute, href, and only when the browser would read it as an http, https or mailto URL, checked with the same
// WHATWG URL parser (so tabs, newlines, case, entities and leading control characters are undone before the check);
// any other link is reduced to its text. Every text and attribute value is escaped; nothing is copied from the input,
// so re-reading the output gives the same output. The bio is never written into any other attribute. Out of scope:
// profile pictures and links to other members.
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const BASE = 'http://citadel.test/u/pilgrim';
const LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** The parts of a parse5 node the writer reads. */
interface TreeNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly namespaceURI?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly TreeNode[];
  readonly content?: { readonly childNodes: readonly TreeNode[] };
}

/** The href to keep, or undefined: only a URL the browser would open as http, https or mailto. */
function safeHref(node: TreeNode): string | undefined {
  const href = node.attrs?.find((a) => a.name === 'href')?.value;
  if (href === undefined) return undefined;
  try {
    return LINK_SCHEMES.has(new URL(href, BASE).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function write(nodes: readonly TreeNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.nodeName === '#text') out += escapeHtml(n.value ?? '');
    else if (n.tagName !== undefined) {
      const inner = write(n.content?.childNodes ?? n.childNodes ?? []);
      const href = n.tagName === 'a' ? safeHref(n) : undefined;
      if (n.namespaceURI !== HTML_NS) out += inner;
      else if (n.tagName === 'b' || n.tagName === 'i') out += `<${n.tagName}>${inner}</${n.tagName}>`;
      else if (href !== undefined) out += `<a href="${escapeHtml(href)}">${inner}</a>`;
      else out += inner; // any other element, or a link the browser would not open safely: its text only
    } // comments and doctypes: dropped
  }
  return out;
}

export function renderBio(bio: string): string {
  return `<div class="bio">${write(parseFragment(bio).childNodes as readonly TreeNode[])}</div>`;
}
