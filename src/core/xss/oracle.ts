// src/core/xss/oracle.ts — the static XSS oracle (docs/superpowers/plans/2026-11-16-phase2-scriptorium-forum.md, A1).
// Parse the exact bytes a browser would get with parse5 (the HTML5 tree-construction algorithm browsers use), walk the
// tree, and decide with the rules table (rules.ts) whether attacker bytes made a sink that runs the lab's marker call.
// No player code ever runs here: nothing is evaluated, fetched or loaded. Every parse is bounded (limits.ts).
import { defaultTreeAdapter, html as parse5Html, parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { SIM_LIMITS, clip } from '../sim/limits.js';
import { XSS_LIMITS } from './limits.js';
import { markerNonce, markerPattern } from './marker.js';
import {
  DOCUMENT_MIME_TYPES, NS, attr, dataUrl, handlerTrigger, hrefOf, javascriptSource, label, navAttributes, sandboxOf,
  schemeOf, scriptKind, scriptMimeRuns, urlText, type Trigger,
} from './rules.js';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Root = DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.DocumentFragment;

/**
 * What kind of sink: an HTML script element, an event handler attribute, a `javascript:` (or `data:`) URL on an
 * element that navigates or frames, anything inside an `<iframe srcdoc>` document, or an SVG script element.
 * (CSS is never script in a current browser: a style sheet's URLs are resources, see linkSinks.)
 */
export type SinkKind = 'script' | 'event-handler' | 'url-scheme' | 'srcdoc' | 'svg-script';
export type SinkTrigger = Trigger;

/** One place on the page that would run code. Frozen; every string is its own copy. */
export interface Sink {
  readonly kind: SinkKind;
  /** Where: `script`, `img[onerror]`, `a[href=javascript:]`, `svg:script`, `iframe[srcdoc] > script` ... */
  readonly detail: string;
  /** 'load': fires by itself as the page loads; 'interaction': when the victim clicks, hovers, focuses... */
  readonly trigger: SinkTrigger;
  /** Runs in an opaque origin (a sandboxed frame, a data: document): it cannot read the page's cookies or DOM. */
  readonly isolated: boolean;
  /** Its code contains the marker call. */
  readonly marker: boolean;
}

/** Which bound stopped part of the analysis (see XSS_LIMITS). */
export type XssLimit = 'size' | 'tags' | 'depth' | 'srcdoc' | 'budget' | 'time';

/**
 * How the HTML reaches the DOM.
 * - 'document' (default): a page the browser loads (or document.write, createContextualFragment): scripts run.
 * - 'innerHTML': element.innerHTML / outerHTML / insertAdjacentHTML into a `<div>`: inserted script elements never
 *   run (HTML or SVG), but event handlers do, and a framed srcdoc document is a document of its own.
 */
export type XssInsertion = 'document' | 'innerHTML';

export interface XssOracleOptions {
  readonly insertion?: XssInsertion;
  /**
   * Whether the victim interacts with the page (default true: the admin reads it, hovers, clicks its links and
   * buttons). false counts only sinks that fire by themselves.
   */
  readonly interact?: boolean;
  /**
   * The page is sandboxed (a `Content-Security-Policy: sandbox ...` response, or the frame it is shown in): the
   * directive's tokens. Without allow-scripts nothing runs; without allow-same-origin everything is isolated.
   */
  readonly sandbox?: string;
}

/** The oracle's answer. Frozen. */
export interface XssVerdict {
  /** A sink would run the marker in the page's origin (with the victim's interaction, unless interact: false). */
  readonly executes: boolean;
  /** The sinks in the tree the browser builds from these bytes, marker or not (at most XSS_LIMITS.sinks). */
  readonly sinks: readonly Sink[];
  /** The marker call is on the page at all: text, an attribute, a comment, a sink. With executes false: shown as text. */
  readonly reachedMarker: boolean;
  /**
   * Mutation XSS: a parse -> serialize -> parse round trip creates a sink that runs the marker which the first
   * parse did not have. That is what a sanitizer that parses, filters and re-serializes lets through: it approved a
   * tree the browser never builds. Checked with scripting on, and (when the page mentions noscript) from a
   * scripting-off parse as DOMParser-based sanitizers make. The serializer is parse5's (HTML's classic algorithm,
   * which does not escape `<` and `>` in attribute values).
   */
  readonly mxss: boolean;
  /** A bound stopped part of the analysis: 'size' / 'tags' (nothing parsed), otherwise what was skipped. */
  readonly limited?: XssLimit;
}

interface Budget { left: number; readonly deadline: number; limited?: XssLimit }

/** The document a walk is in: its origin, whether script elements run in it, and how its sinks are named. */
interface Frame {
  readonly isolated: boolean;
  /** Scripts can run at all (no sandbox, or one with allow-scripts). */
  readonly live: boolean;
  /** Script elements run (false for an innerHTML insertion). */
  readonly scriptElements: boolean;
  readonly prefix: string;
  readonly srcdocDepth: number;
}

interface Walk {
  readonly sinks: Sink[];
  /** Every sink that would run the marker, by signature, counted (all of them, not only the listed ones). */
  readonly firing: Map<string, number>;
  reached: boolean;
  deep: boolean;
  /** A framed document was not analysed (a bound): the walk's sinks are not the whole story. */
  incomplete: boolean;
}

interface Context { readonly re: RegExp; readonly interact: boolean; readonly budget: Budget }

/** `<` followed by a letter, `!`, `/` or `?`: every tag, comment or doctype starts with one (an upper bound on tokens). */
function tagOpens(s: string): number {
  let n = 0;
  for (let i = s.indexOf('<'); i !== -1 && i < s.length - 1; i = s.indexOf('<', i + 1)) {
    const c = s.charCodeAt(i + 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 33 || c === 47 || c === 63) n++;
  }
  return n;
}

function limit(b: Budget, why: XssLimit): undefined {
  b.limited ??= why;
  return undefined;
}

const divContext = (): Element => defaultTreeAdapter.createElement('div', parse5Html.NS.HTML, []);

/** One bounded parse: within the tag cap (for fresh input), the budget and the deadline; a stack overflow is a bound. */
function parseBounded(html: string, insertion: XssInsertion, scripting: boolean, b: Budget, checkTags: boolean): Root | undefined {
  if (checkTags && tagOpens(html) > XSS_LIMITS.tags) return limit(b, 'tags');
  if (html.length > b.left) return limit(b, 'budget');
  if (performance.now() > b.deadline) return limit(b, 'time');
  b.left -= html.length;
  try {
    return insertion === 'document'
      ? parse(html, { scriptingEnabled: scripting })
      : parseFragment(divContext(), html, { scriptingEnabled: scripting });
  } catch (e) {
    if (e instanceof RangeError) return limit(b, 'depth'); // parse5 recursed too deep: the bounds above make it rare
    throw e;
  }
}

function textOf(el: Element): string {
  let s = '';
  for (const c of el.childNodes) if (c.nodeName === '#text') s += (c as DefaultTreeAdapterTypes.TextNode).value;
  return s;
}

function addSink(w: Walk, f: Frame, ctx: Context, kind: SinkKind, detail: string, trigger: Trigger, isolated: boolean, marker: boolean): void {
  const s: Sink = Object.freeze({
    kind: f.srcdocDepth > 0 ? 'srcdoc' : kind, detail: clip(`${f.prefix}${detail}`, XSS_LIMITS.detailLength),
    trigger, isolated: f.isolated || isolated, marker,
  });
  if (marker) w.reached = true;
  if (w.sinks.length < XSS_LIMITS.sinks) w.sinks.push(s);
  if (s.marker && !s.isolated && (s.trigger === 'load' || ctx.interact)) {
    const sig = `${s.kind}|${s.detail}|${s.trigger}`;
    w.firing.set(sig, (w.firing.get(sig) ?? 0) + 1);
  }
}

/** The sinks one element makes (its script, its handlers, its URLs, its framed document). */
function elementSinks(el: Element, f: Frame, ctx: Context, w: Walk): void {
  const html = el.namespaceURI === NS.HTML;
  const svg = el.namespaceURI === NS.SVG;
  // Script elements (not inserted by innerHTML).
  if ((html || svg) && el.tagName === 'script' && f.scriptElements) {
    const kind = scriptKind(el);
    if (kind !== undefined) {
      const sinkKind: SinkKind = svg ? 'svg-script' : 'script';
      const name = label(el);
      const src = html ? attr(el, 'src') : hrefOf(el)?.value;
      if (src === undefined) {
        addSink(w, f, ctx, sinkKind, name, 'load', false, ctx.re.test(textOf(el)));
      } else {
        const url = urlText(src);
        if (schemeOf(url) === 'data') {
          const d = dataUrl(url);
          if (d !== undefined && scriptMimeRuns(d.mime, kind)) addSink(w, f, ctx, sinkKind, `${name}[${html ? 'src' : 'href'}=data:]`, 'load', false, ctx.re.test(d.text));
        } else if (url !== '') {
          addSink(w, f, ctx, sinkKind, `${name}[${html ? 'src' : 'href'}]`, 'load', false, false); // its code is not on the page
        }
      }
    }
  }
  // Event handler attributes.
  for (const a of el.attrs) {
    if (a.namespace !== undefined || !a.name.startsWith('on')) continue;
    const trigger = handlerTrigger(el, a.name, f.scriptElements);
    if (trigger !== undefined) addSink(w, f, ctx, 'event-handler', `${label(el)}[${a.name}]`, trigger, false, ctx.re.test(a.value));
  }
  // javascript: and data: URLs on navigations and frames.
  const sandbox = html && (el.tagName === 'iframe' || el.tagName === 'frame') && attr(el, 'sandbox') !== undefined
    ? sandboxOf(attr(el, 'sandbox') ?? '') : undefined;
  for (const [rule, name, value] of navAttributes(el)) {
    const url = urlText(value);
    const scheme = schemeOf(url);
    if (rule.frame && sandbox !== undefined && !sandbox.scripts) continue; // a sandbox without allow-scripts runs nothing
    if (scheme === 'javascript' && rule.javascript) {
      addSink(w, f, ctx, 'url-scheme', `${label(el)}[${name}=javascript:]`, rule.trigger, sandbox !== undefined && !sandbox.sameOrigin, ctx.re.test(javascriptSource(url)));
    } else if (scheme === 'data' && rule.frame) {
      const d = dataUrl(url);
      if (d !== undefined && DOCUMENT_MIME_TYPES.has(d.mime)) addSink(w, f, ctx, 'url-scheme', `${label(el)}[${name}=data:]`, 'load', true, ctx.re.test(d.text));
    }
  }
  // A framed srcdoc document: a document of its own (scripts run), in this page's origin unless sandboxed.
  const srcdoc = html && el.tagName === 'iframe' ? attr(el, 'srcdoc') : undefined;
  if (srcdoc !== undefined && (sandbox === undefined || sandbox.scripts)) {
    if (f.srcdocDepth >= XSS_LIMITS.srcdocDepth) {
      limit(ctx.budget, 'srcdoc');
      w.incomplete = true;
      return;
    }
    const doc = parseBounded(srcdoc, 'document', true, ctx.budget, true);
    if (doc === undefined) {
      w.incomplete = true;
      return;
    }
    walkInto(doc, {
      isolated: f.isolated || (sandbox !== undefined && !sandbox.sameOrigin), live: true, scriptElements: true,
      prefix: `${f.prefix}iframe[srcdoc] > `, srcdocDepth: f.srcdocDepth + 1,
    }, ctx, w);
  }
}

/** Walk a tree (iteratively: a deep tree must not overflow the stack), in document order, into `w`. */
function walkInto(root: Root, f: Frame, ctx: Context, w: Walk): void {
  const stack: { readonly node: Node; readonly depth: number; readonly inert: boolean }[] = [];
  const push = (children: readonly Node[], depth: number, inert: boolean): void => {
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth, inert });
  };
  push(root.childNodes, 1, false);
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, depth, inert } = item;
    if (node.nodeName === '#text') {
      if (!w.reached && ctx.re.test((node as DefaultTreeAdapterTypes.TextNode).value)) w.reached = true;
      continue;
    }
    if (node.nodeName === '#comment') {
      if (!w.reached && ctx.re.test((node as DefaultTreeAdapterTypes.CommentNode).data)) w.reached = true;
      continue;
    }
    if (!('tagName' in node)) continue; // a doctype
    const el = node as Element;
    if (depth > XSS_LIMITS.depth) w.deep = true;
    if (!w.reached) for (const a of el.attrs) if (ctx.re.test(a.value)) { w.reached = true; break; }
    if (!inert && f.live) elementSinks(el, f, ctx, w);
    // A template's content is inert: no script runs, no image loads, no handler fires until a script clones it.
    if (el.tagName === 'template' && el.namespaceURI === NS.HTML) push((el as DefaultTreeAdapterTypes.Template).content.childNodes, depth + 1, true);
    else push(el.childNodes, depth + 1, inert);
  }
}

function walk(root: Root, f: Frame, ctx: Context): Walk {
  const w: Walk = { sinks: [], firing: new Map(), reached: false, deep: false, incomplete: false };
  walkInto(root, f, ctx, w);
  return w;
}

/** Whether a serialize -> parse round trip of `tree` adds a sink that runs the marker (`before` is its walk). */
function roundTripAdds(tree: Root, before: Walk, insertion: XssInsertion, scripting: boolean, f: Frame, ctx: Context): boolean {
  if (before.deep || before.incomplete) {
    if (before.deep) limit(ctx.budget, 'depth');
    return false;
  }
  const again = parseBounded(serialize(tree, { scriptingEnabled: scripting }), insertion, true, ctx.budget, false);
  if (again === undefined) return false;
  const after = walk(again, f, ctx);
  for (const [sig, n] of after.firing) if (n > (before.firing.get(sig) ?? 0)) return true;
  return false;
}

function insertionOf(x: unknown): XssInsertion {
  if (x === undefined) return 'document';
  if (x === 'document' || x === 'innerHTML') return x;
  throw new Error(`xssOracle: insertion must be 'document' or 'innerHTML' (got ${JSON.stringify(x)})`);
}

const refused = (why: XssLimit): XssVerdict => Object.freeze({ executes: false, sinks: Object.freeze([]), reachedMarker: false, mxss: false, limited: why });

/**
 * Would a browser that receives `html` run the marker call `marker` (`hvwa('<nonce>')`, from markerCall / newMarker)?
 * Parses with scripting enabled, as a real browser; pure; no code runs. A page over XSS_LIMITS.htmlLength (or with
 * more than XSS_LIMITS.tags tags) is refused unparsed: `executes: false, limited: 'size' | 'tags'`.
 */
export function xssOracle(html: string, marker: string, opts: XssOracleOptions = {}): XssVerdict {
  const re = markerPattern(markerNonce(marker));
  const insertion = insertionOf(opts.insertion);
  if (opts.sandbox !== undefined && typeof opts.sandbox !== 'string') throw new Error('xssOracle: sandbox must be a string of tokens');
  const page = typeof html === 'string' ? html : '';
  if (page.length > XSS_LIMITS.htmlLength) return refused('size');
  const budget: Budget = { left: XSS_LIMITS.parseBudget, deadline: performance.now() + XSS_LIMITS.timeMs };
  const tree = parseBounded(page, insertion, true, budget, true);
  if (tree === undefined) return refused(budget.limited ?? 'size');
  const sandbox = opts.sandbox === undefined ? undefined : sandboxOf(opts.sandbox);
  const top: Frame = {
    isolated: sandbox !== undefined && !sandbox.sameOrigin, live: sandbox === undefined || sandbox.scripts,
    scriptElements: insertion === 'document', prefix: '', srcdocDepth: 0,
  };
  const ctx: Context = { re, interact: opts.interact !== false, budget };
  const first = walk(tree, top, ctx);
  let mxss = roundTripAdds(tree, first, insertion, true, top, ctx);
  if (!mxss && !first.deep && !first.incomplete && /noscript/i.test(page)) {
    // A sanitizer that parses with scripting off (DOMParser, a template element) sees noscript content as markup.
    const off = parseBounded(page, insertion, false, budget, false);
    if (off !== undefined) mxss = roundTripAdds(off, walk(off, top, ctx), insertion, false, top, ctx);
  }
  return Object.freeze({
    executes: first.firing.size > 0, sinks: Object.freeze([...first.sinks]), reachedMarker: first.reached, mxss,
    ...(budget.limited === undefined ? {} : { limited: budget.limited }),
  });
}

/**
 * The page as a browser would read it back: parsed (a document, or a `<div>`'s innerHTML), then serialized. The
 * round trip the mXSS check makes, for a sanitizer that must reach a fixed point (SC-06 Divine). Undefined over the
 * bounds (size, tags, depth).
 */
export function roundTrip(html: string, opts: { readonly insertion?: XssInsertion } = {}): string | undefined {
  const insertion = insertionOf(opts.insertion);
  if (typeof html !== 'string' || html.length > XSS_LIMITS.htmlLength) return undefined;
  const budget: Budget = { left: XSS_LIMITS.parseBudget, deadline: Infinity };
  const tree = parseBounded(html, insertion, true, budget, true);
  if (tree === undefined) return undefined;
  const ctx: Context = { re: /(?!)/, interact: true, budget };
  if (walk(tree, { isolated: false, live: false, scriptElements: false, prefix: '', srcdocDepth: 0 }, ctx).deep) return undefined;
  return serialize(tree);
}

// --- Links and resources (no script: mail clients run none) ----------------------------------------------------------

/** One URL a page or mail would request: a link the victim can follow, or a resource fetched as it renders. Frozen. */
export interface LinkSink {
  readonly kind: 'link' | 'resource';
  /** `a`, `img`, `svg:image`, `style` ... */
  readonly element: string;
  /** `href`, `src`, `xlink:href`, `style` (an inline style), '' (a style element's text). */
  readonly attribute: string;
  /** The URL as written, entity-decoded and trimmed as a URL parser does (unresolved: classify it with classifySimUrl). */
  readonly url: string;
  readonly trigger: Trigger;
}

const LINK_HTML: Readonly<Record<string, readonly (readonly [string, 'link' | 'resource'])[]>> = Object.freeze({
  a: [['href', 'link']], area: [['href', 'link']], form: [['action', 'link']], button: [['formaction', 'link']],
  img: [['src', 'resource'], ['srcset', 'resource']], video: [['src', 'resource'], ['poster', 'resource']], audio: [['src', 'resource']],
  source: [['src', 'resource'], ['srcset', 'resource']], track: [['src', 'resource']], iframe: [['src', 'resource']],
  frame: [['src', 'resource']], embed: [['src', 'resource']], object: [['data', 'resource']], script: [['src', 'resource']],
  body: [['background', 'resource']], table: [['background', 'resource']], td: [['background', 'resource']], th: [['background', 'resource']],
});
const FETCHING_LINK_RELS = /(^|\s)(stylesheet|icon|preload|prefetch|modulepreload|apple-touch-icon|manifest)(\s|$)/i;
const CSS_URL_RE = /@import\s*(?:"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;

/**
 * Every link and resource URL in `html`, in document order (at most XSS_LIMITS.sinks), for a lab whose victim runs
 * no script: an HTML mail (FP-12: an attacker `<a href>` the admin clicks, an `<img>` its client loads). Parses as a
 * mail client does, with scripting off (`scripting: true` parses as a browser page). Template content is inert. CSS
 * `url()` and `@import` in style elements and attributes are resources. Over the bounds: no URLs.
 */
export function linkSinks(html: string, opts: { readonly scripting?: boolean } = {}): readonly LinkSink[] {
  const out: LinkSink[] = [];
  if (typeof html !== 'string' || html.length > XSS_LIMITS.htmlLength) return Object.freeze(out);
  const budget: Budget = { left: XSS_LIMITS.parseBudget, deadline: Infinity };
  const doc = parseBounded(html, 'document', opts.scripting === true, budget, true);
  if (doc === undefined) return Object.freeze(out);
  const add = (kind: LinkSink['kind'], element: string, attribute: string, raw: string): void => {
    const url = urlText(raw);
    if (url === '' || out.length >= XSS_LIMITS.sinks) return;
    out.push(Object.freeze({
      kind, element: clip(element, XSS_LIMITS.detailLength), attribute: clip(attribute, XSS_LIMITS.detailLength),
      url: clip(url, SIM_LIMITS.urlLength + 1), trigger: kind === 'link' ? 'interaction' : 'load',
    }));
  };
  const css = (element: string, attribute: string, text: string): void => {
    for (const m of text.matchAll(CSS_URL_RE)) add('resource', element, attribute, m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '');
  };
  const stack: Node[] = [...doc.childNodes].reverse();
  for (let node = stack.pop(); node !== undefined && out.length < XSS_LIMITS.sinks; node = stack.pop()) {
    if (!('tagName' in node)) continue;
    const el = node as Element;
    const name = label(el);
    if (el.namespaceURI === NS.HTML && Object.hasOwn(LINK_HTML, el.tagName)) {
      for (const [a, kind] of LINK_HTML[el.tagName]) {
        const value = attr(el, a);
        if (value === undefined) continue;
        if (a === 'srcset') for (const candidate of value.split(',')) add(kind, name, a, candidate.trim().split(/[\t\n\f\r ]+/)[0] ?? '');
        else add(kind, name, a, value);
      }
    } else if (el.namespaceURI === NS.HTML && el.tagName === 'input') {
      if ((attr(el, 'type') ?? '').trim().toLowerCase() === 'image') add('resource', name, 'src', attr(el, 'src') ?? '');
      add('link', name, 'formaction', attr(el, 'formaction') ?? '');
    } else if (el.namespaceURI === NS.HTML && el.tagName === 'link') {
      if (FETCHING_LINK_RELS.test(attr(el, 'rel') ?? '')) add('resource', name, 'href', attr(el, 'href') ?? '');
    } else if (el.namespaceURI === NS.SVG && ['a', 'image', 'use', 'feImage', 'script'].includes(el.tagName)) {
      const href = hrefOf(el);
      if (href !== undefined) add(el.tagName === 'a' ? 'link' : 'resource', name, href.name, href.value);
    }
    const style = attr(el, 'style');
    if (style !== undefined) css(name, 'style', style);
    if (el.tagName === 'style') css(name, '', textOf(el));
    const children = el.tagName === 'template' && el.namespaceURI === NS.HTML ? [] : el.childNodes; // template content is inert
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return Object.freeze(out);
}
