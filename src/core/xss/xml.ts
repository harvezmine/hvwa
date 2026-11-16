// src/core/xss/xml.ts — a bounded, namespace-aware XML reader for the oracle's XML documents (a page served as
// image/svg+xml, application/xhtml+xml, text/xml ...). parse5 is an HTML parser: an SVG served as XML must be read as
// XML, where namespaces decide what an element is (no xmlns: nothing is SVG; an <img> in the SVG namespace is no image)
// and names are case-sensitive. It builds the same node shapes parse5's tree adapter does, so the oracle's walk and rules
// apply unchanged. One index scanner, linear, no regex on attacker text.
//
// A DOCTYPE whose internal subset declares an entity or an attribute list is refused whole ('dtd'): Chrome expands the
// entities (markup or code) and applies ATTLIST defaults (a handler), which this reader does not model.
//
// Errors behave as in Chrome 157 (measured): parsing stops at the first well-formedness error and what was read before
// stays. An element whose start tag was read keeps its handlers; a script runs only if its end tag was read; an <svg>'s
// load event fires only if it closed, and the document element's only if the whole document is well-formed.
import { defaultTreeAdapter as A, type DefaultTreeAdapterTypes } from 'parse5';
import { XSS_LIMITS } from './limits.js';
import { NS } from './ns.js';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Template = DefaultTreeAdapterTypes.Template;

/** Where an element's children go: a template's content fragment, or the element itself. */
const childrenOf = (el: Element): ParentNode =>
  el.namespaceURI === NS.HTML && el.tagName === 'template' ? A.getTemplateContent(el as Template) : el;

/** What readXml() read. */
export interface XmlRead {
  readonly document: DefaultTreeAdapterTypes.Document;
  readonly wellFormed: boolean;
  /**
   * Nothing is judged: 'nodes', the tree outgrew XSS_LIMITS.elements or XSS_LIMITS.attributeText; 'dtd', the DOCTYPE's
   * internal subset declares an entity or an attribute list (Chrome would expand or apply them).
   */
  readonly limited?: 'nodes' | 'dtd';
}

const PREDEFINED: Readonly<Record<string, string>> = Object.freeze({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' });

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
/** XML's NameStartChar, for one UTF-16 code unit (a code point past the BMP is checked as a surrogate pair by name()). */
const isNameStart = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a
  || (c >= 0xc0 && c <= 0xd6) || (c >= 0xd8 && c <= 0xf6) || (c >= 0xf8 && c <= 0x2ff) || (c >= 0x370 && c <= 0x37d)
  || (c >= 0x37f && c <= 0x1fff) || c === 0x200c || c === 0x200d || (c >= 0x2070 && c <= 0x218f) || (c >= 0x2c00 && c <= 0x2fef)
  || (c >= 0x3001 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfdcf) || (c >= 0xfdf0 && c <= 0xfffd);
/** XML's NameChar, for one UTF-16 code unit. */
const isNameChar = (c: number): boolean => isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0xb7
  || (c >= 0x300 && c <= 0x36f) || c === 0x203f || c === 0x2040;
/** A surrogate pair at i that encodes a code point XML names allow (#x10000-#xEFFFF). */
const isNamePair = (s: string, i: number): boolean => {
  const hi = s.charCodeAt(i);
  const lo = s.charCodeAt(i + 1);
  return hi >= 0xd800 && hi <= 0xdb7f && lo >= 0xdc00 && lo <= 0xdfff; // high surrogates up to DB7F: at most U+EFFFF
};
/** XML's Char production (a surrogate pair is checked by the caller as two code units). */
const isXmlChar = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xfffd && c !== 0xfffe);

class XmlError {
  constructor(readonly why: string) {}
}
class TooBig {}
class DtdDeclarations {}

interface Open {
  readonly el: Element;
  readonly qname: string;
  /** Prefix -> namespace in scope here ('' is the default namespace). */
  readonly scope: ReadonlyMap<string, string>;
}

class Reader {
  private i = 0;
  readonly document = A.createDocument();
  private readonly stack: Open[] = [];
  readonly closed = new Set<Element>();
  root: Element | undefined;
  private rootClosed = false;
  private elements = 0;
  private attributeText = 0;

  constructor(private readonly s: string) {}

  private fail(why: string): never { throw new XmlError(why); }
  private at(word: string): boolean { return this.s.startsWith(word, this.i); }
  private skipSpace(): void { while (this.i < this.s.length && isSpace(this.s.charCodeAt(this.i))) this.i++; }
  private parent(): ParentNode { return this.stack.at(-1)?.el ?? this.document; }
  private scope(): ReadonlyMap<string, string> { return this.stack.at(-1)?.scope ?? new Map([['xml', NS.XML]]); }

  /** Check every character from i to end is an XML Char (surrogates paired). */
  private checkChars(from: number, to: number): void {
    for (let k = from; k < to; k++) {
      const c = this.s.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = this.s.charCodeAt(k + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff) || k + 1 >= to) this.fail('a lone surrogate');
        k++;
      } else if ((c >= 0xdc00 && c <= 0xdfff) || !isXmlChar(c)) {
        this.fail('a character XML does not allow');
      }
    }
  }

  private name(): string {
    const start = this.i;
    const step = (ok: (c: number) => boolean): boolean => {
      if (this.i >= this.s.length) return false;
      if (isNamePair(this.s, this.i)) { this.i += 2; return true; }
      if (!ok(this.s.charCodeAt(this.i))) return false;
      this.i++;
      return true;
    };
    if (!step(isNameStart)) this.fail('a name was expected');
    while (step(isNameChar));
    // The name ends where the markup goes on: a character no name may hold here (Chrome 157 stops at `<g\u2190/>`).
    const next = this.s.charCodeAt(this.i);
    if (this.i < this.s.length && !isSpace(next) && next !== 0x2f && next !== 0x3e && next !== 0x3d && next !== 0x3f && next !== 0x3b) {
      this.fail('a character XML names do not allow');
    }
    return this.s.slice(start, this.i);
  }

  /**
   * `<?xml version="1.x" (encoding="...")? (standalone="yes|no")? ?>`, its pseudo-attributes in that order and no other
   * (Chrome 157 stops at `version="9.9" foo="bar"`).
   */
  private xmlDeclaration(): void {
    this.i += '<?xml'.length;
    const pseudo = (name: string, valid: RegExp, required: boolean): void => {
      const before = this.i;
      this.skipSpace();
      if (!this.at(name)) {
        if (required) this.fail(`the XML declaration needs ${name}`);
        this.i = before;
        return;
      }
      if (this.i === before) this.fail('the XML declaration needs white space');
      this.i += name.length;
      this.skipSpace();
      if (this.s[this.i] !== '=') this.fail('a bad XML declaration');
      this.i++;
      this.skipSpace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.fail('a bad XML declaration');
      const end = this.s.indexOf(quote, this.i + 1);
      if (end === -1 || !valid.test(this.s.slice(this.i + 1, end))) this.fail(`a bad ${name} in the XML declaration`);
      this.i = end + 1;
    };
    pseudo('version', /^[0-9]+\.[0-9]+$/, true);
    pseudo('encoding', /^[A-Za-z][A-Za-z0-9._-]*$/, false);
    pseudo('standalone', /^(yes|no)$/, false);
    this.skipSpace();
    if (!this.at('?>')) this.fail('a bad XML declaration');
    this.i += 2;
  }

  /** `&...;` at i: its text. Only the five predefined entities and character references are read (a DTD's are not). */
  private reference(): string {
    const end = this.s.indexOf(';', this.i);
    if (end === -1) this.fail('an unterminated reference');
    const body = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    if (body.startsWith('#')) {
      // Any number of leading zeros (Chrome 157 reads &#x0000041;); at most 8 significant digits after them.
      const hex = body[1] === 'x';
      const digits = (hex ? body.slice(2) : body.slice(1)).replace(/^0+(?=.)/, '');
      const n = (hex ? /^[0-9a-fA-F]{1,8}$/ : /^[0-9]{1,8}$/).test(digits) ? parseInt(digits, hex ? 16 : 10) : NaN;
      if (!Number.isFinite(n) || n > 0x10ffff || (n < 0x10000 && (!isXmlChar(n) || (n >= 0xd800 && n <= 0xdfff)))) this.fail('a bad character reference');
      return String.fromCodePoint(n);
    }
    if (!Object.hasOwn(PREDEFINED, body)) this.fail(`the entity &${body}; is not one of the five predefined ones`);
    return PREDEFINED[body];
  }

  /** A comment, a processing instruction or a doctype at i (after the root has started only the first two). */
  private markupDeclaration(): void {
    if (this.at('<!--')) {
      const end = this.s.indexOf('-->', this.i + 4);
      if (end === -1) this.fail('an unterminated comment');
      const data = this.s.slice(this.i + 4, end);
      if (data.includes('--') || data.endsWith('-')) this.fail('"--" in a comment');
      this.checkChars(this.i + 4, end);
      A.appendChild(this.parent(), A.createCommentNode(data));
      this.i = end + 3;
    } else if (this.at('<?')) {
      const end = this.s.indexOf('?>', this.i + 2);
      if (end === -1) this.fail('an unterminated processing instruction');
      this.i += 2;
      if (this.name().toLowerCase() === 'xml') this.fail('an XML declaration that is not first');
      this.checkChars(this.i, end);
      this.i = end + 2;
    } else {
      this.fail('markup that is not allowed here');
    }
  }

  /** `<!DOCTYPE name ...>`, an internal subset `[...]` skipped (its declarations are not expanded). */
  private doctype(): void {
    this.i += '<!DOCTYPE'.length;
    if (!isSpace(this.s.charCodeAt(this.i))) this.fail('a doctype without a name');
    this.skipSpace();
    this.name();
    let start = -1;
    let end = -1;
    for (let quote = 0, subset = false; ; this.i++) {
      if (this.i >= this.s.length) this.fail('an unterminated doctype');
      const c = this.s.charCodeAt(this.i);
      if (quote !== 0) { if (c === quote) quote = 0; continue; }
      if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x5b) { subset = true; if (start === -1) start = this.i; } // [
      else if (c === 0x5d) { subset = false; end = this.i; } // ]
      else if (c === 0x3e && !subset) { this.i++; break; } // >
    }
    // Entities and attribute defaults in the internal subset change the document (Chrome expands and applies them):
    // refuse it rather than judge a different tree. Element declarations and comments change nothing here.
    const internal = start === -1 ? '' : this.s.slice(start, end === -1 ? this.i : end);
    if (internal.includes('<!ENTITY') || internal.includes('<!ATTLIST')) throw new DtdDeclarations();
  }

  private count(attrs: readonly { readonly name: string; readonly value: string }[]): void {
    this.elements++;
    for (const a of attrs) this.attributeText += a.name.length + a.value.length;
    if (this.elements > XSS_LIMITS.elements || this.attributeText > XSS_LIMITS.attributeText) throw new TooBig();
  }

  private startTag(): void {
    if (this.rootClosed) this.fail('content after the document element');
    this.i++; // <
    const qname = this.name();
    const raw: { qname: string; value: string }[] = [];
    const names = new Set<string>();
    for (;;) {
      const before = this.i;
      this.skipSpace();
      if (this.at('/>') || this.at('>')) break;
      if (this.i === before) this.fail('attributes must be separated by white space');
      const aname = this.name();
      this.skipSpace();
      if (this.s[this.i] !== '=') this.fail('an attribute without a value');
      this.i++;
      this.skipSpace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.fail('an unquoted attribute value');
      this.i++;
      let value = '';
      for (;;) {
        if (this.i >= this.s.length) this.fail('an unterminated attribute value');
        const ch = this.s[this.i];
        if (ch === quote) { this.i++; break; }
        if (ch === '<') this.fail('"<" in an attribute value');
        if (ch === '&') { value += this.reference(); continue; }
        const start = this.i;
        while (this.i < this.s.length && this.s[this.i] !== quote && this.s[this.i] !== '<' && this.s[this.i] !== '&') this.i++;
        this.checkChars(start, this.i);
        value += this.s.slice(start, this.i).replace(/[\t\n]/g, ' '); // attribute-value normalization (CR is already LF)
      }
      if (names.has(aname)) this.fail(`a repeated attribute ${aname}`);
      names.add(aname);
      raw.push({ qname: aname, value });
    }
    const selfClosing = this.at('/>');
    this.i += selfClosing ? 2 : 1;
    // Namespaces: declarations first, then the element's and its attributes' prefixes.
    // Copy on write: an element that declares no namespace shares its parent's scope (copying the map for every element
    // made a document with many prefixes cost prefixes x elements).
    const declares = raw.some((a) => a.qname === 'xmlns' || a.qname.startsWith('xmlns:'));
    const scope = declares ? new Map(this.scope()) : this.scope() as Map<string, string>;
    for (const a of declares ? raw : []) {
      if (a.qname === 'xmlns') scope.set('', a.value);
      else if (a.qname.startsWith('xmlns:')) {
        const p = a.qname.slice(6);
        // xmlns:xml may only restate the xml namespace (legal; Chrome goes on); nothing else may bind it, or xmlns.
        if (p === 'xml' ? a.value !== NS.XML : p === '' || p.includes(':') || a.value === '' || p === 'xmlns' || a.value === NS.XML) {
          this.fail('a bad namespace declaration');
        }
        scope.set(p, a.value);
      }
    }
    const split = (q: string): readonly [string, string] => {
      const colon = q.indexOf(':');
      if (colon === -1) return ['', q];
      if (colon === 0 || colon === q.length - 1 || q.indexOf(':', colon + 1) !== -1) this.fail(`a bad qualified name ${q}`);
      return [q.slice(0, colon), q.slice(colon + 1)];
    };
    const [prefix, local] = split(qname);
    const ns = scope.get(prefix);
    if (prefix !== '' && ns === undefined) this.fail(`the prefix ${prefix} is not declared`);
    const attrs = raw.map((a) => {
      if (a.qname === 'xmlns') return { name: 'xmlns', value: a.value, namespace: NS.XMLNS };
      const [p, n] = split(a.qname);
      if (p === '') return { name: n, value: a.value };
      if (p === 'xmlns') return { name: n, value: a.value, prefix: 'xmlns', namespace: NS.XMLNS };
      const uri = scope.get(p);
      if (uri === undefined) this.fail(`the prefix ${p} is not declared`);
      return { name: n, value: a.value, prefix: p, namespace: uri };
    });
    const expanded = new Set<string>();
    for (const a of attrs) {
      const key = `${a.namespace ?? ''} ${a.name}`;
      if (expanded.has(key)) this.fail('two attributes with the same expanded name');
      expanded.add(key);
    }
    this.count(attrs);
    const el = A.createElement(local, (ns ?? '') as DefaultTreeAdapterTypes.Element['namespaceURI'], attrs as DefaultTreeAdapterTypes.Element['attrs']);
    if (el.namespaceURI === NS.HTML && local === 'template') A.setTemplateContent(el as Template, A.createDocumentFragment());
    const parent = this.parent();
    A.appendChild('tagName' in parent ? childrenOf(parent) : parent, el);
    this.root ??= el;
    if (selfClosing) {
      this.closed.add(el);
      if (this.stack.length === 0) this.rootClosed = true;
    } else {
      this.stack.push({ el, qname, scope });
    }
  }

  private endTag(): void {
    this.i += 2; // </
    const qname = this.name();
    this.skipSpace();
    if (this.s[this.i] !== '>') this.fail('a bad end tag');
    this.i++;
    const open = this.stack.pop();
    if (open === undefined || open.qname !== qname) this.fail(`</${qname}> does not close the open element`);
    this.closed.add(open.el);
    if (this.stack.length === 0) this.rootClosed = true;
  }

  private text(): void {
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i] !== '<' && this.s[this.i] !== '&') this.i++;
    this.checkChars(start, this.i);
    const chunk = this.s.slice(start, this.i);
    if (chunk.includes(']]>')) this.fail('"]]>" in text');
    this.addText(chunk);
  }

  private addText(chunk: string): void {
    if (chunk === '') return;
    if (this.stack.length === 0) {
      for (let k = 0; k < chunk.length; k++) if (!isSpace(chunk.charCodeAt(k))) this.fail('text outside the document element');
      return;
    }
    const parent = this.parent() as Element;
    A.insertText(childrenOf(parent), chunk);
  }

  read(): void {
    if (this.s.charCodeAt(0) === 0xfeff) this.i = 1;
    if (this.at('<?xml') && (isSpace(this.s.charCodeAt(this.i + 5)) || this.at('<?xml?>'))) this.xmlDeclaration();
    let doctypeSeen = false;
    while (this.i < this.s.length) {
      if (this.s[this.i] === '<') {
        if (this.at('</')) this.endTag();
        else if (this.at('<![CDATA[')) {
          if (this.stack.length === 0) this.fail('CDATA outside the document element');
          const end = this.s.indexOf(']]>', this.i + 9);
          if (end === -1) this.fail('an unterminated CDATA section');
          this.checkChars(this.i + 9, end);
          this.addText(this.s.slice(this.i + 9, end));
          this.i = end + 3;
        } else if (this.at('<!DOCTYPE')) {
          if (doctypeSeen || this.root !== undefined) this.fail('a doctype in the wrong place');
          doctypeSeen = true;
          this.doctype();
        } else if (this.at('<!') || this.at('<?')) this.markupDeclaration();
        else this.startTag();
      } else if (this.s[this.i] === '&') {
        if (this.stack.length === 0) this.fail('a reference outside the document element');
        this.addText(this.reference());
      } else {
        this.text();
      }
    }
    if (this.stack.length > 0) this.fail('the document ends inside an element');
    if (this.root === undefined) this.fail('no document element');
  }
}

/** Remove what never ran because the parse stopped: unclosed scripts, and load handlers whose load never came. */
function afterError(r: Reader): void {
  const stack: ParentNode[] = [r.document]; // iterative: the tree can be thousands deep
  for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
    for (const child of [...parent.childNodes]) {
      if (!('tagName' in child)) continue;
      const el = child as Element;
      const script = el.tagName === 'script' && (el.namespaceURI === NS.HTML || el.namespaceURI === NS.SVG);
      if (script && !r.closed.has(el)) { A.detachNode(el); continue; }
      if (el.namespaceURI === NS.SVG && el.tagName === 'svg' && (!r.closed.has(el) || el === r.root)) {
        el.attrs = el.attrs.filter((a) => !(a.namespace === undefined && a.name === 'onload'));
      }
      stack.push(childrenOf(el));
    }
  }
}

/**
 * Read `text` as an XML document (the caller has applied the size and tag caps). Line ends are normalized first, as
 * the XML spec says. Not well-formed: the tree read before the first error, as Chrome keeps it.
 */
export function readXml(text: string): XmlRead {
  const r = new Reader(text.replace(/\r\n?/g, '\n'));
  try {
    r.read();
    return { document: r.document, wellFormed: true };
  } catch (e) {
    if (e instanceof TooBig) return { document: A.createDocument(), wellFormed: false, limited: 'nodes' };
    if (e instanceof DtdDeclarations) return { document: A.createDocument(), wellFormed: false, limited: 'dtd' };
    if (!(e instanceof XmlError)) throw e;
    afterError(r);
    return { document: r.document, wellFormed: false };
  }
}
