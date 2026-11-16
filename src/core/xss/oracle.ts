// src/core/xss/oracle.ts — the static XSS oracle (docs/superpowers/plans/2026-11-16-phase2-scriptorium-forum.md, A1).
// Parse the exact bytes a browser would get with parse5 (the HTML5 tree-construction algorithm browsers use), walk the
// tree, and decide with the rules table (rules.ts) whether attacker bytes made a sink that runs the lab's marker call.
// No player code ever runs here: nothing is evaluated, fetched or loaded. Every parse is bounded (limits.ts).
import { defaultTreeAdapter, html as parse5Html, parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { SIM_LIMITS, clip } from '../sim/limits.js';
import { XSS_LIMITS } from './limits.js';
import { markerNonce, markerPattern } from './marker.js';
import { readXml } from './xml.js';
import {
  DOCUMENT_MIME_TYPES, NS, attr, canHostShadow, dataUrl, handlerTrigger, hrefAnimation, hrefOf, javascriptSource, label,
  navAttributes, sandboxOf, schemeOf, scriptKind, scriptMimeRuns, shadowRootMode, urlText, type Trigger,
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
export type XssLimit = 'size' | 'tags' | 'nodes' | 'depth' | 'srcdoc' | 'budget' | 'time';

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
  /**
   * How the bytes are parsed: 'html' (default, parse5) or 'xml' (a document served as image/svg+xml,
   * application/xhtml+xml, text/xml ...: read as XML with namespaces by core/xss/xml.ts; insertion 'document' only).
   */
  readonly syntax?: 'html' | 'xml';
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
  /**
   * A bound stopped part of the analysis. 'size', 'tags' or 'nodes' with no sinks: the page was refused whole
   * (executes false, deterministically). Otherwise what was skipped: a framed document ('srcdoc', 'nodes', 'budget')
   * or the mXSS round trip ('depth', 'budget', 'time': mxss is then false, not proven).
   */
  readonly limited?: XssLimit;
  /** syntax 'xml' only: whether the document was well-formed (if not, only what was read before the error counts). */
  readonly wellFormed?: boolean;
}

interface Budget { left: number; readonly deadline: number; limited?: XssLimit }

/** The document a walk is in: its origin, whether script elements run in it, and how its sinks are named. */
interface Frame {
  readonly isolated: boolean;
  /** Scripts can run at all (no sandbox, or one with allow-scripts). */
  readonly live: boolean;
  /** Script elements run (false for an innerHTML insertion). */
  readonly scriptElements: boolean;
  /** Declarative shadow roots attach (a document read by the HTML parser: never innerHTML, never XML). */
  readonly dsd: boolean;
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
  /** Elements that already got a declarative shadow root (only the first template attaches). */
  readonly shadowHosts: Set<Node>;
}

interface Context {
  readonly re: RegExp;
  readonly interact: boolean;
  readonly budget: Budget;
  /** Inside an mXSS round trip: its framed-document parses stop at the deadline too. */
  readonly timed: boolean;
}

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

/** Thrown by the bounded tree adapter to stop a parse (never escapes parseBounded). */
class ParseStop {
  constructor(readonly why: 'nodes' | 'time') {}
}

/**
 * parse5's default tree adapter, counting what the parse creates: every element (a formatting element rebuilt in a
 * later block counts again) and its attribute text. Past XSS_LIMITS.elements or XSS_LIMITS.attributeText the parse
 * stops ('nodes'), so a few KB cannot build a tree of a hundred thousand elements. With a deadline (the mXSS round
 * trip only), it also stops once the deadline has passed, looking every 256 elements ('time').
 */
function boundedAdapter(deadline: number | undefined): typeof defaultTreeAdapter {
  let elements = 0;
  let text = 0;
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      elements++;
      for (const a of attrs) text += a.name.length + a.value.length;
      if (elements > XSS_LIMITS.elements || text > XSS_LIMITS.attributeText) throw new ParseStop('nodes');
      if (deadline !== undefined && elements % 256 === 0 && performance.now() > deadline) throw new ParseStop('time');
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
  };
}

interface ParseOptions {
  /** Count `<` openers first (fresh input: the page, a framed document). */
  readonly checkTags: boolean;
  /** Stop at the call's deadline (the mXSS round trip only: time never stops the page or a framed document). */
  readonly timed: boolean;
}

/** One bounded parse: the tag cap (for fresh input), the budget, the tree caps, and for a round trip the deadline. */
function parseBounded(html: string, insertion: XssInsertion, scripting: boolean, b: Budget, o: ParseOptions): Root | undefined {
  if (o.checkTags && tagOpens(html) > XSS_LIMITS.tags) return limit(b, 'tags');
  if (html.length > b.left) return limit(b, 'budget');
  if (o.timed && performance.now() > b.deadline) return limit(b, 'time');
  b.left -= html.length;
  const options = { scriptingEnabled: scripting, treeAdapter: boundedAdapter(o.timed ? b.deadline : undefined) };
  try {
    return insertion === 'document' ? parse(html, options) : parseFragment(divContext(), html, options);
  } catch (e) {
    if (e instanceof ParseStop) return limit(b, e.why);
    if (e instanceof RangeError) return limit(b, 'depth'); // parse5 recursed too deep: the bounds above make it rare
    throw e;
  }
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_PARENTS: ReadonlySet<string> = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/** How much longer than its text a string gets when parse5 escapes it (text: `& < > NBSP`; attributes: `" & NBSP`). */
function escapeGrowth(s: string, attribute: boolean): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x26) n += 4; // &amp;
    else if (c === 0xa0) n += 5; // &nbsp;
    else if (attribute ? c === 0x22 : c === 0x3c || c === 0x3e) n += attribute ? 5 : 3; // &quot; / &lt; &gt;
  }
  return n;
}

/**
 * The exact length of parse5's `serialize(root, { scriptingEnabled })`, without building it (iterative: no recursion
 * on a deep tree). Stops counting once past `limit`. The round trip checks it against the budget before it serializes.
 */
export function serializedLength(root: Root, scripting: boolean, limit = Infinity): number {
  let n = 0;
  const stack: Node[] = [...root.childNodes].reverse();
  for (let node = stack.pop(); node !== undefined && n <= limit; node = stack.pop()) {
    if (node.nodeName === '#text') {
      const { value, parentNode } = node as DefaultTreeAdapterTypes.TextNode;
      const raw = parentNode !== null && 'tagName' in parentNode && parentNode.namespaceURI === NS.HTML
        && (RAW_TEXT_PARENTS.has(parentNode.tagName) || (scripting && parentNode.tagName === 'noscript'));
      n += value.length + (raw ? 0 : escapeGrowth(value, false));
    } else if (node.nodeName === '#comment') {
      n += (node as DefaultTreeAdapterTypes.CommentNode).data.length + 7; // <!--...-->
    } else if (node.nodeName === '#documentType') {
      n += (node as DefaultTreeAdapterTypes.DocumentType).name.length + 11; // <!DOCTYPE ...>
    } else if ('tagName' in node) {
      const el = node as Element;
      n += el.tagName.length + 2; // <tag>
      for (const a of el.attrs) {
        const prefix = a.namespace === undefined ? 0
          : a.namespace === NS.XMLNS ? (a.name === 'xmlns' ? 0 : 6) : a.namespace === NS.XML ? 4 : a.namespace === NS.XLINK ? 6
            : String(a.prefix).length + 1;
        n += prefix + a.name.length + a.value.length + escapeGrowth(a.value, true) + 4; // ` name="value"`
      }
      if (el.namespaceURI === NS.HTML && VOID_ELEMENTS.has(el.tagName)) continue;
      n += el.tagName.length + 3; // </tag>
      const children = el.tagName === 'template' && el.namespaceURI === NS.HTML
        ? (el as DefaultTreeAdapterTypes.Template).content.childNodes : el.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return n;
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
    const doc = parseBounded(srcdoc, 'document', true, ctx.budget, { checkTags: true, timed: ctx.timed });
    if (doc === undefined) {
      w.incomplete = true;
      return;
    }
    walkInto(doc, {
      isolated: f.isolated || (sandbox !== undefined && !sandbox.sameOrigin), live: true, scriptElements: true, dsd: true,
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
  let elements = 0;
  // SMIL href animations whose target is `href="#id"`: resolved against this document's ids once it is all read.
  const ids = new Map<string, Element>();
  const animations: { readonly el: Element; readonly target: string; readonly urls: readonly string[] }[] = [];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, depth, inert } = item;
    // A backstop: every tree here was built under the same cap (boundedAdapter, the XML reader), so this never stops a
    // tree the oracle parsed; it bounds the walk whatever tree it is given.
    if ('tagName' in node && ++elements > XSS_LIMITS.elements) {
      w.incomplete = true;
      limit(ctx.budget, 'nodes');
      return;
    }
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
    const id = attr(el, 'id');
    if (id !== undefined && !ids.has(id)) ids.set(id, el);
    if (!inert && f.live) {
      elementSinks(el, f, ctx, w);
      const animation = hrefAnimation(el);
      if (animation !== undefined && animation.target === undefined) animatedHref(el, el.parentNode, animation.urls, f, ctx, w);
      else if (animation !== undefined) animations.push({ el, target: animation.target ?? '', urls: animation.urls });
    }
    if (el.tagName === 'template' && el.namespaceURI === NS.HTML) {
      // A template's content is inert (no script runs, no image loads, no handler fires until a script clones it),
      // except a declarative shadow root: a page's <template shadowrootmode> on a host that can take one (the first
      // such template per host; never through innerHTML) becomes live content, as Chrome attaches it.
      const host = el.parentNode;
      const live = !inert && f.dsd && shadowRootMode(el) !== undefined && host !== null && 'tagName' in host
        && canHostShadow(host as Element) && !w.shadowHosts.has(host);
      if (live) w.shadowHosts.add(host);
      push((el as DefaultTreeAdapterTypes.Template).content.childNodes, depth + 1, !live);
    } else {
      push(el.childNodes, depth + 1, inert);
    }
  }
  for (const a of animations) animatedHref(a.el, ids.get(a.target) ?? null, a.urls, f, ctx, w);
}

/** An animate/set element that sets its target link's href: a javascript: URL there runs when the victim clicks the link. */
function animatedHref(el: Element, target: DefaultTreeAdapterTypes.ParentNode | null, urls: readonly string[], f: Frame, ctx: Context, w: Walk): void {
  if (target === null || !('tagName' in target) || target.namespaceURI !== NS.SVG || target.tagName !== 'a') return;
  for (const value of urls) {
    const url = urlText(value);
    if (schemeOf(url) === 'javascript') addSink(w, f, ctx, 'url-scheme', `svg:a[href=javascript:] < ${label(el)}`, 'interaction', false, ctx.re.test(javascriptSource(url)));
  }
}

function walk(root: Root, f: Frame, ctx: Context): Walk {
  const w: Walk = { sinks: [], firing: new Map(), reached: false, deep: false, incomplete: false, shadowHosts: new Set() };
  walkInto(root, f, ctx, w);
  return w;
}

/** Whether a serialize -> parse round trip of `tree` adds a sink that runs the marker (`before` is its walk). */
function roundTripAdds(tree: Root, before: Walk, insertion: XssInsertion, scripting: boolean, f: Frame, ctx: Context): boolean {
  if (before.deep || before.incomplete) {
    if (before.deep) limit(ctx.budget, 'depth');
    return false;
  }
  // Late already: no round trip (the page itself was read whole). Too long once serialized: never build the string.
  if (performance.now() > ctx.budget.deadline) return limit(ctx.budget, 'time') ?? false;
  if (serializedLength(tree, scripting, ctx.budget.left) > ctx.budget.left) return limit(ctx.budget, 'budget') ?? false;
  const again = parseBounded(serialize(tree, { scriptingEnabled: scripting }), insertion, true, ctx.budget, { checkTags: false, timed: true });
  if (again === undefined) return false;
  const after = walk(again, f, { ...ctx, timed: true });
  for (const [sig, n] of after.firing) if (n > (before.firing.get(sig) ?? 0)) return true;
  return false;
}

/** An XML document: read with core/xss/xml.ts and walked as any page (no select pass, no round trip: both are HTML's). */
function xmlVerdict(page: string, re: RegExp, opts: XssOracleOptions, budget: Budget): XssVerdict {
  if (tagOpens(page) > XSS_LIMITS.tags) return refused('tags');
  const read = readXml(page);
  if (read.limited !== undefined) return refused(read.limited);
  const sandbox = opts.sandbox === undefined ? undefined : sandboxOf(opts.sandbox);
  const top: Frame = {
    isolated: sandbox !== undefined && !sandbox.sameOrigin, live: sandbox === undefined || sandbox.scripts,
    scriptElements: true, dsd: false, prefix: '', srcdocDepth: 0,
  };
  const w = walk(read.document, top, { re, interact: opts.interact !== false, budget, timed: false });
  return Object.freeze({
    executes: w.firing.size > 0, sinks: Object.freeze([...w.sinks]), reachedMarker: w.reached, mxss: false,
    ...(budget.limited === undefined ? {} : { limited: budget.limited }), wellFormed: read.wellFormed,
  });
}

const sinkKey = (s: Sink): string => `${s.kind}|${s.detail}|${s.trigger}|${s.isolated}|${s.marker}`;

/** The page with every select tag renamed (an unknown element: its content parsed as ordinary markup), read like the page. */
function selectPass(page: string, insertion: XssInsertion, top: Frame, ctx: Context): Walk | undefined {
  const renamed = page.replace(/<(\/?)select(?=[\t\n\f\r />]|$)/gi, '<$1hvwa-select');
  const tree = parseBounded(renamed, insertion, true, ctx.budget, { checkTags: false, timed: false });
  return tree === undefined ? undefined : walk(tree, top, ctx);
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
  const syntax = opts.syntax ?? 'html';
  if (syntax !== 'html' && syntax !== 'xml') throw new Error(`xssOracle: syntax must be 'html' or 'xml' (got ${JSON.stringify(syntax)})`);
  if (syntax === 'xml' && insertion !== 'document') throw new Error("xssOracle: syntax 'xml' reads a document (insertion 'document')");
  const page = typeof html === 'string' ? html : '';
  if (page.length > XSS_LIMITS.htmlLength) return refused('size');
  const budget: Budget = { left: XSS_LIMITS.parseBudget, deadline: performance.now() + XSS_LIMITS.timeMs };
  if (syntax === 'xml') return xmlVerdict(page, re, opts, budget);
  const tree = parseBounded(page, insertion, true, budget, { checkTags: true, timed: false });
  if (tree === undefined) return refused(budget.limited ?? 'size');
  const sandbox = opts.sandbox === undefined ? undefined : sandboxOf(opts.sandbox);
  const top: Frame = {
    isolated: sandbox !== undefined && !sandbox.sameOrigin, live: sandbox === undefined || sandbox.scripts,
    scriptElements: insertion === 'document', dsd: insertion === 'document', prefix: '', srcdocDepth: 0,
  };
  const ctx: Context = { re, interact: opts.interact !== false, budget, timed: false };
  const first = walk(tree, top, ctx);
  // Chrome 135+ parses select content as ordinary markup (the customizable select); parse5 8.0.1 drops most of it. A
  // second, deterministic pass reads the page with select renamed to an unknown element, and its sinks count too.
  const select = /<select/i.test(page) ? selectPass(page, insertion, top, ctx) : undefined;
  let mxss = roundTripAdds(tree, first, insertion, true, top, ctx);
  if (!mxss && !first.deep && !first.incomplete && /noscript/i.test(page)) {
    // A sanitizer that parses with scripting off (DOMParser, a template element) sees noscript content as markup.
    const off = parseBounded(page, insertion, false, budget, { checkTags: false, timed: true });
    if (off !== undefined) mxss = roundTripAdds(off, walk(off, top, { ...ctx, timed: true }), insertion, false, top, ctx);
  }
  const sinks = [...first.sinks];
  const seen = new Set(sinks.map(sinkKey));
  for (const extra of select?.sinks ?? []) if (!seen.has(sinkKey(extra)) && sinks.length < XSS_LIMITS.sinks) sinks.push(extra);
  return Object.freeze({
    executes: first.firing.size > 0 || (select?.firing.size ?? 0) > 0, sinks: Object.freeze(sinks),
    reachedMarker: first.reached || select?.reached === true, mxss,
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
  const tree = parseBounded(html, insertion, true, budget, { checkTags: true, timed: false });
  if (tree === undefined) return undefined;
  const ctx: Context = { re: /(?!)/, interact: true, budget, timed: false };
  if (walk(tree, { isolated: false, live: false, scriptElements: false, dsd: false, prefix: '', srcdocDepth: 0 }, ctx).deep) return undefined;
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
/**
 * The URLs a style sheet fetches, in order: `url(...)` (quoted or not) and `@import "..."` (an `@import url(...)` is
 * the url() it contains). A hand-written linear scan: the obvious regex (`url\(\s*...\s*\)`) backtracks
 * quadratically on `url(` followed by a long run of spaces.
 */
function cssUrls(text: string): string[] {
  const out: string[] = [];
  const ws = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
  const at = (i: number, word: string): boolean => {
    if (i + word.length > text.length) return false;
    for (let k = 0; k < word.length; k++) {
      const c = text.charCodeAt(i + k);
      if ((c >= 65 && c <= 90 ? c + 32 : c) !== word.charCodeAt(k)) return false;
    }
    return true;
  };
  const skipWs = (i: number): number => { while (i < text.length && ws(text.charCodeAt(i))) i++; return i; };
  /** A quoted string from its opening quote at i: [its text, the index after it], or undefined when unterminated. */
  const quoted = (i: number): readonly [string, number] | undefined => {
    const end = text.indexOf(text[i], i + 1);
    return end === -1 ? undefined : [text.slice(i + 1, end), end + 1];
  };
  for (let i = 0; i < text.length;) {
    if (at(i, 'url(')) {
      let j = skipWs(i + 4);
      let url: string | undefined;
      if (text[j] === '"' || text[j] === "'") {
        const q = quoted(j);
        if (q === undefined) break; // an unterminated string ends the sheet
        [url, j] = q;
      } else {
        const start = j;
        while (j < text.length && text[j] !== ')' && text[j] !== '"' && text[j] !== "'" && !ws(text.charCodeAt(j))) j++;
        url = text.slice(start, j);
      }
      j = skipWs(j);
      if (text[j] === ')') out.push(url); // a url( that does not close is a bad URL: nothing is fetched
      i = Math.max(j, i + 4);
    } else if (at(i, '@import')) {
      const j = skipWs(i + 7);
      const q = text[j] === '"' || text[j] === "'" ? quoted(j) : undefined;
      if (q !== undefined) out.push(q[0]);
      i = q === undefined ? j : q[1]; // `@import url(...)`: the url( is read next
    } else {
      i++;
    }
  }
  return out;
}

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
  const doc = parseBounded(html, 'document', opts.scripting === true, budget, { checkTags: true, timed: false });
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
    for (const url of cssUrls(text)) add('resource', element, attribute, url);
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
