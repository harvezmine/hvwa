// tests/xss-preview.spec.ts — the preview's javascript: links (core/xss/preview.ts). A sandbox="allow-scripts" frame
// never runs a javascript: URL a click navigates to (checked in headless Chrome 157, with and without the meta CSP), so
// the shim catches the click and runs the URL's code as an inline script INSIDE the frame: the player watches the
// payload fire, the frame stays sandboxed. The URL is decoded exactly as the oracle decodes it (urlText, schemeOf,
// javascriptSource in core/xss/rules.ts). The shim runs here in a node:vm context over a minimal fake DOM: test code
// only, nothing of the player's runs in the server.
import { runInContext, createContext } from 'node:vm';
import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';
import { previewFrame } from '../src/core/xss.js';
import { javascriptSource, schemeOf, urlText } from '../src/core/xss/rules.js';

const N = '0123456789abcdef';
const M = `hvwa('${N}')`;

type El = DefaultTreeAdapterTypes.Element;
const elements = (nodes: readonly DefaultTreeAdapterTypes.ChildNode[]): El[] => nodes.filter((n): n is El => 'tagName' in n);

/** The shim script inside a preview frame's srcdoc head (the only script there). */
function shimOf(frameHtml: string): string {
  const [frame] = elements(parseFragment(frameHtml).childNodes);
  const srcdoc = frame.attrs.find((a) => a.name === 'srcdoc')?.value ?? '';
  const [html] = elements(parse(srcdoc).childNodes);
  const [head] = elements(html.childNodes);
  const scripts = elements(head.childNodes).filter((e) => e.tagName === 'script');
  expect(scripts.length).toBe(1);
  return scripts[0].childNodes.map((c) => ('value' in c ? c.value : '')).join('');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * A fake element the shim reads: attributes (by qualified name, so `xlink:href` is not `href`), a tag name, a namespace
 * (default HTML), a parent, a form owner, a type. An SVG element's `href` is an SVGAnimatedString, as in a browser:
 * `baseVal` is its href attribute, else its xlink:href, and `animVal` is that unless a SMIL animation set it (`animVal`).
 */
interface FakeEl {
  readonly localName: string;
  readonly ns?: string;
  readonly type?: string;
  readonly form?: FakeEl | null;
  readonly parent?: FakeEl;
  readonly attrs: Readonly<Record<string, string>>;
  /** SVG only: the href a SMIL animation gives the element now (its animVal), whatever its attributes say. */
  readonly animVal?: string;
}

/**
 * The shim run over a fake DOM: `click(el)` dispatches a click on `el` (or on nothing); `closest(selectors)` walks `el`
 * and its parents for the first whose tag name and required attribute match one of the selectors (`name` or
 * `name[attr]`), as the browser's closest() does. Answers whether the shim cancelled the navigation. Scripts the shim
 * appends run in the same context, as in a browser; `ran` records their code, `banners` the shim's banners.
 */
function frame(marker = M) {
  const listeners: ((e: unknown) => void)[] = [];
  const ran: string[] = [];
  const banners: string[] = [];
  const ctx: Record<string, unknown> = { TextEncoder, TextDecoder };
  const append = (node: { tagName: string; textContent: string }) => {
    if (node.tagName === 'script') {
      ran.push(node.textContent);
      try { runInContext(node.textContent, ctx); } catch { /* a script that throws is reported by a browser, not thrown to the appender */ }
    }
    return node;
  };
  const body = {
    firstChild: null,
    appendChild: append,
    insertBefore: (node: { textContent: string }) => { banners.push(node.textContent); return node; },
  };
  ctx.window = ctx;
  ctx.location = { hash: '' };
  ctx.document = {
    body, documentElement: body,
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'click') listeners.push(fn); },
    createElement: (tagName: string) => ({ tagName, textContent: '', className: '', remove: () => {} }),
  };
  createContext(ctx);
  runInContext(shimOf(previewFrame('<p>x</p>', { marker })), ctx);
  interface DomEl {
    readonly localName: string; readonly namespaceURI: string; readonly type: string; readonly form: DomEl | null;
    readonly parentElement: DomEl | null; readonly href: unknown;
    hasAttribute(n: string): boolean; getAttribute(n: string): string | null; closest(selectors: string): DomEl | null;
  }
  const matches = (el: FakeEl, selector: string): boolean => {
    const m = /^([a-z]+)(?:\[([a-z:-]+)\])?$/.exec(selector.trim());
    if (m === null) throw new Error(`fake closest(): unsupported selector ${selector}`);
    return el.localName === m[1] && (m[2] === undefined || Object.hasOwn(el.attrs, m[2]));
  };
  const wrap = (el: FakeEl | null | undefined): DomEl | null => {
    if (el === null || el === undefined) return null;
    const ns = el.ns ?? HTML_NS;
    const base = el.attrs.href ?? el.attrs['xlink:href'] ?? '';
    return {
      localName: el.localName, namespaceURI: ns, type: el.type ?? '', form: wrap(el.form), parentElement: wrap(el.parent),
      // HTMLAnchorElement.href is a URL string; SVGAElement.href is an SVGAnimatedString.
      href: ns === SVG_NS ? { baseVal: base, animVal: el.animVal ?? base } : el.attrs.href,
      hasAttribute: (n: string) => Object.hasOwn(el.attrs, n), getAttribute: (n: string) => (Object.hasOwn(el.attrs, n) ? el.attrs[n] : null),
      closest: (selectors: string) => {
        for (let at: FakeEl | undefined = el; at !== undefined; at = at.parent) {
          const here = at;
          if (selectors.split(',').some((sel) => matches(here, sel))) return wrap(here);
        }
        return null;
      },
    };
  };
  const click = (el: FakeEl | null): boolean => {
    let prevented = false;
    const target = el === null ? { closest: () => null } : wrap(el);
    for (const fn of listeners) fn({ target, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { click, ran, banners };
}

/** What the oracle says a javascript: URL in this attribute value runs, or undefined when it is no javascript: URL. */
const oracleCode = (value: string): string | undefined => {
  const url = urlText(value);
  return schemeOf(url) === 'javascript' ? javascriptSource(url) : undefined;
};

const link = (href: string): FakeEl => ({ localName: 'a', attrs: { href } });

describe('preview: a javascript: link runs inside the sandboxed frame, decoded as the oracle decodes it', () => {
  // Attribute values as the HTML parser gives them (entities already undone, as parse5 gives the oracle).
  const fromParser = (html: string): string => elements(parseFragment(html).childNodes)[0].attrs.find((a) => a.name === 'href')?.value ?? '';
  const CORPUS: readonly string[] = [
    `javascript:${M}`, `JaVaScRiPt:${M}`, `java\nscript:${M}`, `java\tscript:${M}`, `jav\rascript:${M}`, `\u0001 javascript:${M}`,
    ` javascript:${M} \n`, `javascript:hvwa(%27${N}%27)`, 'javascript:%E2%9C%93', 'javascript:%zz%', 'javascript:%4', 'javascript:',
    fromParser(`<a href="jav&#x09;ascript:${M}">`), fromParser(`<a href="javascript&colon;${M}">`), fromParser('<a href="javascript:&#37;41">'),
    // Not javascript: URLs: the shim leaves them alone (the frame's own rules apply).
    'https://psalms.test/', 'java%3Ascript:x', `data:text/html,<script>${M}</script>`, '#top', '', 'javascript', ' j avascript:x',
    `vbscript:${M}`, ` javascript:${M}`,
  ];

  it('runs exactly the code the oracle reads from the URL, and only for a javascript: URL', () => {
    for (const href of CORPUS) {
      const f = frame();
      const want = oracleCode(href);
      const prevented = f.click(link(href));
      expect(f.ran, JSON.stringify(href)).toEqual(want === undefined ? [] : [want]);
      expect(prevented, JSON.stringify(href)).toBe(want !== undefined);
    }
  });

  it('pins the decoding: case, tabs and newlines, leading controls, percent escapes (bytes, as UTF-8)', () => {
    const run = (href: string): string[] => { const f = frame(); f.click(link(href)); return f.ran; };
    expect(run(`JAVASCRIPT:${M}`)).toEqual([M]);
    expect(run(`java\n\tscript:${M}`)).toEqual([M]);
    expect(run(`\u0001\u001f javascript:${M}`)).toEqual([M]);
    expect(run(`javascript:hvwa(%27${N}%27)`)).toEqual([M]);
    expect(run('javascript:%E2%9C%93')).toEqual(['✓']);
    expect(run('javascript:%zz%')).toEqual(['%zz%']);
    expect(run('java%3Ascript:x')).toEqual([]);
  });

  it('the marker call it runs shows the banner, naming the player\'s own marker', () => {
    const f = frame();
    f.click(link(`java\nscript:${M}`));
    expect(f.banners).toEqual([`hvwa('${N}') ran: your marker`]);
    const other = frame();
    other.click(link("javascript:hvwa('ffffffffffffffff')"));
    expect(other.banners).toEqual(["hvwa('ffffffffffffffff') ran: not your marker"]);
  });

  it('an <area>, and a submit button\'s formaction or its form\'s action, the way the oracle counts them', () => {
    const owner = (action?: string): FakeEl => ({ localName: 'form', attrs: action === undefined ? {} : { action } });
    const cases: [FakeEl, boolean][] = [
      [{ localName: 'area', attrs: { href: `javascript:${M}` } }, true],
      [{ localName: 'button', type: 'submit', form: owner(), attrs: { formaction: `javascript:${M}` } }, true],
      [{ localName: 'input', type: 'submit', form: owner(), attrs: { formaction: `javascript:${M}` } }, true],
      [{ localName: 'input', type: 'image', form: owner(), attrs: { formaction: `javascript:${M}` } }, true],
      [{ localName: 'button', type: 'submit', form: owner(`javascript:${M}`), attrs: {} }, true], // the form's own action
      [{ localName: 'button', type: 'submit', form: owner(`javascript:${M}`), attrs: { formaction: 'https://x.test/' } }, false],
      [{ localName: 'button', type: 'button', form: owner(), attrs: { formaction: `javascript:${M}` } }, false],
      [{ localName: 'button', type: 'reset', form: owner(), attrs: { formaction: `javascript:${M}` } }, false],
      [{ localName: 'input', type: 'text', form: owner(), attrs: { formaction: `javascript:${M}` } }, false],
      [{ localName: 'button', type: 'submit', form: null, attrs: { formaction: `javascript:${M}` } }, false], // no form owner
      [{ localName: 'div', attrs: { href: `javascript:${M}` } }, false],
    ];
    for (const [el, runs] of cases) {
      const f = frame();
      expect(f.click(el), JSON.stringify(el)).toBe(runs);
      expect(f.ran, JSON.stringify(el)).toEqual(runs ? [M] : []);
    }
    const f = frame();
    expect(f.click(null)).toBe(false); // a click on nothing that navigates
    expect(f.ran).toEqual([]);
  });

  it('an SVG anchor runs its EFFECTIVE href (animVal): href, xlink:href, or what a SMIL animation set', () => {
    const svgA = (attrs: Record<string, string>, animVal?: string): FakeEl => ({ localName: 'a', ns: SVG_NS, attrs, ...(animVal === undefined ? {} : { animVal }) });
    const cases: [string, FakeEl, string[]][] = [
      ['href', svgA({ href: `javascript:${M}` }), [M]],
      ['xlink:href', svgA({ 'xlink:href': `javascript:${M}` }), [M]],
      ['xlink:href, decoded as the oracle does', svgA({ 'xlink:href': `\u0001 JAVA\tscript:hvwa(%27${N}%27)` }), [M]],
      ['a SMIL animation of href (no href attribute at all)', svgA({}, `javascript:${M}`), [M]],
      ['a SMIL animation over a harmless href', svgA({ href: '#top' }, `javascript:${M}`), [M]],
      ['a SMIL animation to a harmless href over a javascript: one', svgA({ href: `javascript:${M}` }, '#top'), []],
      ['an SVG anchor with no href', svgA({}), []],
    ];
    for (const [name, el, ran] of cases) {
      const f = frame();
      expect(f.click(el), name).toBe(ran.length > 0);
      expect(f.ran, name).toEqual(ran);
    }
    // the code it runs is exactly the oracle's reading of the effective URL
    const href = `java\nscript:hvwa(%27${N}%27)`;
    const f = frame();
    f.click(svgA({}, href));
    expect(f.ran).toEqual([oracleCode(href)]);
    expect(f.banners).toEqual([`hvwa('${N}') ran: your marker`]);
  });

  it('a click inside an SVG anchor finds it; an anchor that is no link lets the click reach the button around it', () => {
    const svgA: FakeEl = { localName: 'a', ns: SVG_NS, attrs: { 'xlink:href': `javascript:${M}` } };
    const rect: FakeEl = { localName: 'rect', ns: SVG_NS, attrs: {}, parent: { localName: 'g', ns: SVG_NS, attrs: {}, parent: svgA } };
    const f = frame();
    expect(f.click(rect)).toBe(true);
    expect(f.ran).toEqual([M]);
    const form: FakeEl = { localName: 'form', attrs: {} };
    const button: FakeEl = { localName: 'button', type: 'submit', form, attrs: { formaction: `javascript:${M}` } };
    const inside: [string, FakeEl][] = [
      ['an SVG anchor with no href', { localName: 'a', ns: SVG_NS, attrs: {}, parent: button }],
      ['an HTML anchor with no href', { localName: 'a', attrs: {}, parent: button }],
    ];
    for (const [name, inner] of inside) {
      const g = frame();
      expect(g.click(inner), name).toBe(true);
      expect(g.ran, name).toEqual([M]);
    }
    // an HTML anchor still reads its href attribute, never an SVG-only property
    const h = frame();
    expect(h.click({ localName: 'a', attrs: { 'xlink:href': `javascript:${M}` } })).toBe(false);
    expect(h.ran).toEqual([]);
  });

  it('the frame stays what it was: sandboxed scripts only, no same-origin, one shim, no eval', () => {
    const out = previewFrame(`<a href="javascript:${M}">x</a>`, { marker: M });
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    const code = shimOf(out);
    expect(code).not.toMatch(/innerHTML|document\.write|eval|Function\(|setTimeout\(\s*['"`]/);
    expect(code).not.toContain('</script');
    expect(code).toContain('createElement("script")'); // the decoded code runs as an inline script, inside the frame
  });
});
