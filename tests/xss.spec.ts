// The static XSS oracle (src/core/xss/): does attacker HTML create an executable sink that runs the lab's marker?
// No player JS ever runs here: parse5 builds the tree a browser would, and a rules table decides what would execute.
import { readFileSync, readdirSync } from 'node:fs';
import { parseFragment, parse, type DefaultTreeAdapterTypes } from 'parse5';
import { createRequire } from 'node:module';
import net from 'node:net';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_CSP, PREVIEW_SANDBOX, XSS_LIMITS, linkSinks, markerCall, previewFrame, roundTrip, xssOracle, type Sink, type XssOracleOptions,
} from '../src/core/xss.js';

const N = '0123456789abcdef';
const M = markerCall(N); // hvwa('0123456789abcdef')
const OTHER = markerCall('fedcba9876543210');
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The sinks that run the marker (in the page's origin): what `executes` is made of. */
const firing = (html: string, opts?: XssOracleOptions): Sink[] => {
  const v = xssOracle(html, M, opts);
  return v.sinks.filter((s) => s.marker && !s.isolated && (s.trigger === 'load' || opts?.interact !== false));
};

// Every TCP connection goes through net.Socket.prototype.connect: nothing in this file may open one.
const socketConnect = vi.spyOn(net.Socket.prototype, 'connect');
afterAll(() => {
  const calls = socketConnect.mock.calls.length;
  socketConnect.mockRestore();
  expect(calls, 'a socket was opened while the xss specs ran').toBe(0);
});

describe('xssOracle: the sink matrix (what a browser would run)', () => {
  // [row, html, kind, detail, trigger]: each one runs the marker in the page's origin.
  const SINKS: readonly [string, string, Sink['kind'], string, Sink['trigger']][] = [
    // element
    ['element: inline script', `<script>${M}</script>`, 'script', 'script', 'load'],
    ['element: upper-case tag', `<SCRIPT>${M}</SCRIPT>`, 'script', 'script', 'load'],
    ['element: module script', `<script type=module>${M}</script>`, 'script', 'script', 'load'],
    ['element: a JS MIME type, spaced and mixed case', `<script type=" Text/JavaScript ">${M}</script>`, 'script', 'script', 'load'],
    ['element: legacy language attribute', `<script language=JavaScript1.5>${M}</script>`, 'script', 'script', 'load'],
    ['element: data: script source', `<script src="data:,${encodeURIComponent(M)}"></script>`, 'script', 'script[src=data:]', 'load'],
    ['element: base64 data: script source', `<script src="data:text/javascript;base64,${b64(M)}"></script>`, 'script', 'script[src=data:]', 'load'],
    // attribute
    ['attribute: img onerror', `<img src=x onerror=${M}>`, 'event-handler', 'img[onerror]', 'load'],
    ['attribute: entity-encoded quotes are decoded first', `<img src=x onerror="hvwa(&#39;${N}&#39;)">`, 'event-handler', 'img[onerror]', 'load'],
    ['attribute: double-quoted marker', `<img src=x onerror='hvwa("${N}")'>`, 'event-handler', 'img[onerror]', 'load'],
    ['attribute: svg onload', `<svg onload=${M}>`, 'event-handler', 'svg:svg[onload]', 'load'],
    ['attribute: body onload (merged onto the page body)', `<p>hi</p><body onload=${M}>`, 'event-handler', 'body[onload]', 'load'],
    ['attribute: autofocus + onfocus', `<input autofocus onfocus=${M}>`, 'event-handler', 'input[onfocus]', 'load'],
    ['attribute: details open + ontoggle', `<details open ontoggle=${M}>`, 'event-handler', 'details[ontoggle]', 'load'],
    ['attribute: style onload', `<style onload=${M}></style>`, 'event-handler', 'style[onload]', 'load'],
    ['attribute: a nested svg onload', `<svg><svg onload=${M}></svg></svg>`, 'event-handler', 'svg:svg[onload]', 'load'],
    ['attribute: iframe onload (about:blank loads too)', `<iframe onload=${M}></iframe>`, 'event-handler', 'iframe[onload]', 'load'],
    ['attribute: img onload with a data: source', `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" onload=${M}>`, 'event-handler', 'img[onload]', 'load'],
    ['attribute: input type=image onerror', `<input type=image src=x onerror=${M}>`, 'event-handler', 'input[onerror]', 'load'],
    ['attribute: video source onerror', `<video><source src=x onerror=${M}></video>`, 'event-handler', 'source[onerror]', 'load'],
    ['attribute: video onloadstart', `<video src=x onloadstart=${M}></video>`, 'event-handler', 'video[onloadstart]', 'load'],
    ['attribute: object onerror', `<object data=x onerror=${M}></object>`, 'event-handler', 'object[onerror]', 'load'],
    ['attribute: stylesheet link onerror', `<link rel=stylesheet href=x onerror=${M}>`, 'event-handler', 'link[onerror]', 'load'],
    ['attribute: svg image onerror', `<svg><image href=x onerror=${M} /></svg>`, 'event-handler', 'svg:image[onerror]', 'load'],
    ['element: a classic data: script runs whatever its MIME type', `<script src="data:image/png,${encodeURIComponent(M)}"></script>`, 'script', 'script[src=data:]', 'load'],
    ['attribute: onmouseover (the admin hovers)', `<b onmouseover=${M}>x</b>`, 'event-handler', 'b[onmouseover]', 'interaction'],
    ['attribute: onclick', `<button onclick=${M}>go</button>`, 'event-handler', 'button[onclick]', 'interaction'],
    ['attribute: onfocus on a focusable element', `<div tabindex=0 onfocus=${M}>x</div>`, 'event-handler', 'div[onfocus]', 'interaction'],
    // URL scheme
    ['url-scheme: a href javascript:', `<a href="javascript:${M}">x</a>`, 'url-scheme', 'a[href=javascript:]', 'interaction'],
    ['url-scheme: spaces, tab, case, entities, percent-encoding', `<a href=" JaVa&#x09;sCrIpT&colon;hvwa(%27${N}%27)">x</a>`, 'url-scheme', 'a[href=javascript:]', 'interaction'],
    ['url-scheme: iframe src javascript:', `<iframe src="javascript:${M}"></iframe>`, 'url-scheme', 'iframe[src=javascript:]', 'load'],
    ['url-scheme: form action javascript:', `<form action="javascript:${M}"><button>go</button></form>`, 'url-scheme', 'form[action=javascript:]', 'interaction'],
    ['url-scheme: button formaction javascript:', `<form><button formaction="javascript:${M}">go</button></form>`, 'url-scheme', 'button[formaction=javascript:]', 'interaction'],
    ['url-scheme: area href javascript:', `<map name=m><area href="javascript:${M}"></map>`, 'url-scheme', 'area[href=javascript:]', 'interaction'],
    ['url-scheme: svg a xlink:href', `<svg><a xlink:href="javascript:${M}"><text>x</text></a></svg>`, 'url-scheme', 'svg:a[xlink:href=javascript:]', 'interaction'],
    ['url-scheme: svg a href', `<svg><a href="javascript:${M}"><text>x</text></a></svg>`, 'url-scheme', 'svg:a[href=javascript:]', 'interaction'],
    // srcdoc
    ['srcdoc: a script in the framed document', `<iframe srcdoc="<script>${M}</script>"></iframe>`, 'srcdoc', 'iframe[srcdoc] > script', 'load'],
    ['srcdoc: an escaped handler, decoded by the attribute', `<iframe srcdoc="&lt;img src=x onerror=${M}&gt;"></iframe>`, 'srcdoc', 'iframe[srcdoc] > img[onerror]', 'load'],
    ['srcdoc: sandbox with allow-same-origin keeps the origin', `<iframe sandbox="allow-scripts allow-same-origin" srcdoc="<script>${M}</script>"></iframe>`, 'srcdoc', 'iframe[srcdoc] > script', 'load'],
    ['srcdoc: nested once', `<iframe srcdoc="<iframe srcdoc=&quot;<script>${M}</script>&quot;></iframe>"></iframe>`, 'srcdoc', 'iframe[srcdoc] > iframe[srcdoc] > script', 'load'],
    // svg-script and SVG/MathML foreign content
    ['svg-script: script in svg', `<svg><script>${M}</script></svg>`, 'svg-script', 'svg:script', 'load'],
    ['svg-script: entities ARE decoded in svg script', `<svg><script>hvwa(&#39;${N}&#39;)</script></svg>`, 'svg-script', 'svg:script', 'load'],
    ['svg: SMIL set onbegin', `<svg><set attributeName=x onbegin=${M} /></svg>`, 'event-handler', 'svg:set[onbegin]', 'load'],
    ['svg: SMIL animate onend', `<svg><animate attributeName=x dur=1s onend=${M} /></svg>`, 'event-handler', 'svg:animate[onend]', 'load'],
    ['svg: foreignObject switches back to HTML', `<svg><foreignObject><img src=x onerror=${M}></foreignObject></svg>`, 'event-handler', 'img[onerror]', 'load'],
    ['math: mtext switches back to HTML', `<math><mtext><img src=x onerror=${M}></mtext></math>`, 'event-handler', 'img[onerror]', 'load'],
    // style: a style element is raw text in HTML, but markup in SVG, so an img breaks out of the foreign content
    ['style: svg style lets an img break out', `<svg><style><img src=x onerror=${M}>`, 'event-handler', 'img[onerror]', 'load'],
  ];

  for (const [row, html, kind, detail, trigger] of SINKS) {
    it(row, () => {
      const v = xssOracle(html, M);
      expect(v.executes, html).toBe(true);
      expect(v.reachedMarker, html).toBe(true);
      expect(firing(html), html).toContainEqual({ kind, detail, trigger, isolated: false, marker: true });
    });
  }

  it('the same sinks with another player\'s marker run nothing of yours', () => {
    for (const [, html] of SINKS) {
      const v = xssOracle(html, OTHER);
      expect(v.executes, html).toBe(false);
      expect(v.reachedMarker, html).toBe(false);
    }
  });
});

describe('xssOracle: escaped sources and non-sinks run nothing', () => {
  // [why, html, reachedMarker]: the marker may be on the page, but no browser would run it.
  const NEGATIVES: readonly [string, string, boolean][] = [
    ['escaped text', `&lt;script&gt;${M}&lt;/script&gt;`, true],
    ['angle brackets inside a quoted attribute value stay in it', `<input value="<script>${M}</script>">`, true],
    ['an escaped attribute breakout', `<input value="&quot;&gt;&lt;img src=x onerror=${M}&gt;">`, true],
    ['textarea (RCDATA)', `<textarea><script>${M}</script></textarea>`, true],
    ['title (RCDATA)', `<title><img src=x onerror=${M}></title>`, true],
    ['xmp (raw text)', `<xmp><img src=x onerror=${M}></xmp>`, true],
    ['iframe content (raw text)', `<iframe><script>${M}</script></iframe>`, true],
    ['noembed (raw text)', `<noembed><img src=x onerror=${M}></noembed>`, true],
    ['noscript with scripting on (raw text)', `<noscript><img src=x onerror=${M}></noscript>`, true],
    ['template content is inert', `<template><img src=x onerror=${M}><script>${M}</script></template>`, true],
    ['a comment', `<!-- <script>${M}</script> -->`, true],
    ['script type text/plain', `<script type="text/plain">${M}</script>`, true],
    ['script type text/template', `<script type="text/template">${M}</script>`, true],
    ['script nomodule (skipped by module browsers)', `<script nomodule>${M}</script>`, true],
    ['an external script ignores its inline text', `<script src="http://attacker.test/x.js">${M}</script>`, true],
    ['entities are NOT decoded in an HTML script', `<script>hvwa(&#39;${N}&#39;)</script>`, false],
    ['a marker in the wrong case', `<script>HVWA('${N}')</script>`, false],
    ['a marker without quotes', `<script>hvwa(${N})</script>`, false],
    ['an unknown event attribute', `<div onfoo=${M}>x</div>`, true],
    ['a data- attribute', `<div data-onload=${M}>x</div>`, true],
    ['onerror on an element that never errors', `<input onerror=${M}><div onerror=${M}>x</div>`, true],
    ['onload on an element that never loads', `<p onload=${M}>x</p>`, true],
    ['onload on an svg child element', `<svg><g onload=${M}></g><rect onload=${M} /></svg>`, true],
    ['img onload with a source that fails', `<img src=x onload=${M}>`, true],
    ['stylesheet onload with a source that fails', `<link rel=stylesheet href=x onload=${M}>`, true],
    ['onerror on an icon link or an embed (never fired)', `<link rel=icon href=x onerror=${M}><embed src=x onerror=${M}>`, true],
    ['onerror on an iframe (never fired)', `<iframe src=x onerror=${M}></iframe>`, true],
    ['img onerror without a source', `<img onerror=${M}>`, true],
    ['a JS type with parameters is not an essence match', `<script type="text/javascript; charset=utf-8">${M}</script>`, true],
    ['a module needs a JavaScript MIME type', `<script type=module src="data:,${encodeURIComponent(M)}"></script>`, true],
    ['object data javascript: (not run)', `<object data="javascript:${M}"></object>`, true],
    ['embed src javascript: (not run)', `<embed src="javascript:${M}">`, true],
    ['math href javascript: (MathML links are not supported)', `<math href="javascript:${M}">x</math>`, true],
    ['marquee onstart (not modelled)', `<marquee onstart=${M}>x</marquee>`, true],
    ['onfocus on an element that cannot take focus', `<b onfocus=${M}>x</b>`, true],
    ['a window handler on an ordinary element', `<div onpageshow=${M}>x</div>`, true],
    ['a top-level data: link (browsers block it)', `<a href="data:text/html,<script>${M}</script>">x</a>`, true],
    ['img src javascript: never runs', `<img src="javascript:${M}">`, true],
    ['meta refresh to javascript: (blocked)', `<meta http-equiv=refresh content="0;url=javascript:${M}">`, true],
    ['link stylesheet javascript:', `<link rel=stylesheet href="javascript:${M}">`, true],
    ['base href javascript:', `<base href="javascript:${M}"><a href=x>x</a>`, true],
    ['vbscript:', `<a href="vbscript:${M}">x</a>`, true],
    ['an http link carrying the marker', `<a href="http://attacker.test/${M}">x</a>`, true],
    ['style element (raw text, never script)', `<style>${M}</style>`, true],
    ['a javascript: URL in CSS', `<div style="background:url('javascript:${M}')">x</div>`, true],
    ['@import javascript:', `<style>@import 'javascript:${M}';</style>`, true],
    ['escaped markup inside svg style is text', `<svg><style>&lt;img src=x onerror=${M}&gt;</style></svg>`, true],
  ];

  for (const [why, html, reached] of NEGATIVES) {
    it(why, () => {
      const v = xssOracle(html, M);
      expect(v.executes, html).toBe(false);
      expect(v.reachedMarker, html).toBe(reached);
      expect(firing(html), html).toEqual([]);
    });
  }

  it('isolated origins run the payload but cannot reach the page: a data: frame, a sandboxed srcdoc', () => {
    for (const [html, detail] of [
      [`<iframe src="data:text/html,<script>${M}</script>"></iframe>`, 'iframe[src=data:]'],
      [`<iframe src="data:text/html;base64,${b64(`<script>${M}</script>`)}"></iframe>`, 'iframe[src=data:]'],
      [`<iframe sandbox="allow-scripts" srcdoc="<script>${M}</script>"></iframe>`, 'iframe[srcdoc] > script'],
      [`<iframe sandbox="allow-scripts" srcdoc="<iframe srcdoc=&quot;<script>${M}</script>&quot;></iframe>"></iframe>`, 'iframe[srcdoc] > iframe[srcdoc] > script'],
    ] as const) {
      const v = xssOracle(html, M);
      expect(v.executes, html).toBe(false);
      expect(v.sinks, html).toContainEqual(expect.objectContaining({ detail, isolated: true, marker: true }));
    }
  });

  it('a sandbox without allow-scripts runs nothing at all', () => {
    for (const sandbox of ['', 'allow-same-origin', 'allow-forms allow-popups']) {
      const v = xssOracle(`<iframe sandbox="${sandbox}" srcdoc="<script>${M}</script>"></iframe>`, M);
      expect(v.executes, sandbox).toBe(false);
      expect(v.sinks.filter((s) => s.marker), sandbox).toEqual([]);
      expect(v.reachedMarker).toBe(true);
    }
  });

  it('a script element\'s src ignores its text, and an external script is a sink without the marker', () => {
    const v = xssOracle(`<script src="http://attacker.test/x.js">${M}</script>`, M);
    expect(v.sinks).toEqual([{ kind: 'script', detail: 'script[src]', trigger: 'load', isolated: false, marker: false }]);
  });
});

describe('xssOracle: options', () => {
  it('insertion innerHTML: inserted scripts never run (HTML or SVG); handlers and framed documents do', () => {
    const opts: XssOracleOptions = { insertion: 'innerHTML' };
    expect(xssOracle(`<script>${M}</script>`, M, opts)).toMatchObject({ executes: false, reachedMarker: true });
    expect(xssOracle(`<svg><script>${M}</script></svg>`, M, opts).executes).toBe(false);
    expect(xssOracle(`<body onload=${M}>`, M, opts).executes).toBe(false); // a body tag is dropped in a <div>
    // An inserted script is never fetched either, so its error and load events never fire.
    expect(xssOracle(`<script src=x onerror=${M}></script>`, M, opts).executes).toBe(false);
    expect(xssOracle(`<svg><script href=x onerror=${M}></script></svg>`, M, opts).executes).toBe(false);
    expect(xssOracle(`<script src=x onerror=${M}></script>`, M).executes).toBe(true);
    expect(xssOracle(`<img src=x onerror=${M}>`, M, opts).executes).toBe(true);
    expect(xssOracle(`<svg onload=${M}>`, M, opts).executes).toBe(true);
    expect(xssOracle(`<iframe srcdoc="<script>${M}</script>"></iframe>`, M, opts).executes).toBe(true);
  });

  it('interact: false counts only sinks that fire by themselves', () => {
    const opts: XssOracleOptions = { interact: false };
    expect(xssOracle(`<b onmouseover=${M}>x</b>`, M, opts).executes).toBe(false);
    expect(xssOracle(`<a href="javascript:${M}">x</a>`, M, opts).executes).toBe(false);
    expect(xssOracle(`<img src=x onerror=${M}>`, M, opts).executes).toBe(true);
    expect(xssOracle(`<input autofocus onfocus=${M}>`, M, opts).executes).toBe(true);
  });

  it('sandbox (a CSP sandbox on the response): no allow-scripts runs nothing; no allow-same-origin is isolated', () => {
    const page = `<img src=x onerror=${M}>`;
    expect(xssOracle(page, M, { sandbox: '' })).toMatchObject({ executes: false, sinks: [] });
    const isolated = xssOracle(page, M, { sandbox: 'allow-scripts' });
    expect(isolated.executes).toBe(false);
    expect(isolated.sinks).toEqual([{ kind: 'event-handler', detail: 'img[onerror]', trigger: 'load', isolated: true, marker: true }]);
    expect(xssOracle(page, M, { sandbox: 'ALLOW-SCRIPTS allow-same-origin' }).executes).toBe(true);
  });

  it('refuses a marker that is not a marker call, and unknown options', () => {
    expect(() => xssOracle('<p>x</p>', 'alert(1)')).toThrow(/marker/);
    expect(() => xssOracle('<p>x</p>', `hvwa('${N}') `)).toThrow(/marker/);
    expect(() => xssOracle('<p>x</p>', M, { insertion: 'outerHTML' as never })).toThrow(/insertion/);
    expect(() => markerCall('not hex!')).toThrow(/nonce/);
    expect(() => markerCall('abc')).toThrow(/nonce/);
  });

  it('a non-string page is an empty page', () => {
    expect(xssOracle(undefined as never, M)).toEqual({ executes: false, sinks: [], reachedMarker: false, mxss: false });
  });
});

describe('xssOracle: the marker and its reachability', () => {
  it('matches the call in any quote style, with spaces, as a method or a property call', () => {
    for (const code of [`hvwa( '${N}' )`, `hvwa(\`${N}\`)`, `window.hvwa("${N}")`, `x=1;top.hvwa('${N}');`]) {
      expect(xssOracle(`<img src=x onerror="${code.replace(/"/g, '&quot;')}">`, M).executes, code).toBe(true);
    }
    for (const code of [`hvwa('${N}x')`, `hvwa('${N}")`, `hvwa('${N.slice(1)}')`, `hvwa ('${N}'+'')`, `hvwax('${N}')`]) {
      expect(xssOracle(`<img src=x onerror="${code.replace(/"/g, '&quot;')}">`, M).executes, code).toBe(false);
    }
  });

  it('reachedMarker: the call is on the page anywhere (text, attribute, comment, srcdoc, template, script text)', () => {
    for (const html of [
      `<p>${M}</p>`, `<p title="${M}">x</p>`, `<!--${M}-->`, `<iframe sandbox srcdoc="${M}"></iframe>`,
      `<template><p>${M}</p></template>`, `<script type=text/plain>${M}</script>`, `<a href="javascript:hvwa(%27${N}%27)">x</a>`,
    ]) {
      expect(xssOracle(html, M).reachedMarker, html).toBe(true);
    }
    expect(xssOracle('<p>no marker</p>', M).reachedMarker).toBe(false);
    expect(xssOracle(`<p>${M.replace('(', '')}</p>`, M).reachedMarker).toBe(false); // a filter mangled it
  });

  it('isolates players: each player\'s page runs only their own marker', () => {
    const a = markerCall('aaaaaaaaaaaaaaaa');
    const b = markerCall('bbbbbbbbbbbbbbbb');
    const pageA = `<img src=x onerror=${a}>`;
    expect(xssOracle(pageA, a).executes).toBe(true);
    expect(xssOracle(pageA, b)).toMatchObject({ executes: false, reachedMarker: false });
  });
});

// Known mutation corpora: each is safe when a sanitizer parses it, and becomes script once its serialization is
// parsed again (serialize -> reparse differential). Pinned with their exact round trips, so a parse5 bump that changes
// serialization is caught here.
const MGLYPH = `<math><mtext><table><mglyph><style><img src=x onerror=${M}>`;
const FORM = `<form><math><mtext></form><form><mglyph><style></math><img src onerror=${M}>`;
const NESTED = `<math><mtext><table><mglyph><svg><mtext><style><path id="</style><img onerror=${M} src>">`;
const NOSCRIPT = `<p>A comment:</p><noscript><p title="</noscript><img src=x onerror=${M}>"></p></noscript>`;

describe('xssOracle: mXSS (serialize -> reparse differential)', () => {
  it('flags a construct that parses safe and re-parses into script (MathML mglyph/style, DOMPurify form, nested mtext)', () => {
    for (const html of [MGLYPH, FORM, NESTED]) {
      for (const insertion of ['document', 'innerHTML'] as const) {
        const v = xssOracle(html, M, { insertion });
        expect(v, `${insertion} ${html}`).toMatchObject({ executes: false, mxss: true, reachedMarker: true });
      }
    }
  });

  it('flags the noscript differential: a scripting-off sanitizer sees an attribute, the browser sees an img', () => {
    const v = xssOracle(NOSCRIPT, M);
    expect(v.mxss).toBe(true);
    expect(v.executes).toBe(true); // the browser (scripting on) runs it from the bytes themselves
    expect(xssOracle(`<noscript><p title="x">plain</p></noscript>`, M).mxss).toBe(false);
  });

  it('a stable page is a fixed point: no mXSS, whether or not it executes', () => {
    for (const html of ['<p>hi <b>there</b></p>', `<img src=x onerror=${M}>`, `<svg><style><img src=x onerror=${M}>`, `&lt;script&gt;${M}`]) {
      expect(xssOracle(html, M).mxss, html).toBe(false);
    }
  });

  it('a mutation that creates only someone else\'s sink is not your mXSS', () => {
    expect(xssOracle(MGLYPH, OTHER).mxss).toBe(false);
  });

  it('pins the corpora\'s round trips (innerHTML: a <div>\'s serialization parsed again)', () => {
    const rt = (html: string) => roundTrip(html, { insertion: 'innerHTML' });
    expect(rt(MGLYPH)).toBe(`<math><mtext><mglyph><style><img src=x onerror=${M}></style></mglyph><table></table></mtext></math>`);
    expect(rt(FORM)).toBe(`<form><math><mtext><form><mglyph><style></math><img src onerror=${M}></style></mglyph></form></mtext></math></form>`);
    expect(rt(NESTED)).toBe(`<math><mtext><mglyph><svg><mtext><style><path id="</style><img onerror=${M} src>"></path></style></mtext></svg></mglyph><table></table></mtext></math>`);
    expect(rt(rt(MGLYPH) ?? '')).toBe(`<math><mtext><mglyph><style></style></mglyph><img src="x" onerror="${M}"><table></table></mtext></math>`);
  });

  it('roundTrip: a page or a fragment, serialized as a browser would', () => {
    expect(roundTrip('<p>x')).toBe('<html><head></head><body><p>x</p></body></html>');
    expect(roundTrip('<p a=1 b>x', { insertion: 'innerHTML' })).toBe('<p a="1" b="">x</p>');
    expect(roundTrip('x'.repeat(XSS_LIMITS.htmlLength + 1))).toBeUndefined();
    expect(roundTrip('<div>'.repeat(XSS_LIMITS.depth + 1))).toBeUndefined();
  });
});

describe('xssOracle: bounds (size, tags, depth, srcdoc, budget, time)', () => {
  it(`refuses a page over ${XSS_LIMITS.htmlLength} characters before parsing it`, () => {
    const big = `<script>${M}</script>`.padEnd(XSS_LIMITS.htmlLength + 1, 'x');
    expect(xssOracle(big, M)).toEqual({ executes: false, sinks: [], reachedMarker: false, mxss: false, limited: 'size' });
    expect(xssOracle(big.slice(0, XSS_LIMITS.htmlLength), M).executes).toBe(true);
  });

  it(`refuses a page with more than ${XSS_LIMITS.tags} tags (it bounds tree depth and per-token work)`, () => {
    const many = `<img src=x onerror=${M}>${'<b>'.repeat(XSS_LIMITS.tags)}`;
    expect(xssOracle(many, M)).toMatchObject({ executes: false, limited: 'tags' });
    expect(xssOracle(many.slice(0, -3), M).executes).toBe(true);
  });

  it(`checks a tree deeper than ${XSS_LIMITS.depth} for sinks, but skips the round trip (parse5 serializes recursively)`, () => {
    const v = xssOracle(`${'<div>'.repeat(XSS_LIMITS.depth + 10)}<img src=x onerror=${M}>`, M);
    expect(v).toMatchObject({ executes: true, mxss: false, limited: 'depth' });
  });

  it('nested templates up to the tag cap parse (parse5 recurses on EOF in a template)', () => {
    expect(() => xssOracle('<template>'.repeat(XSS_LIMITS.tags), M)).not.toThrow();
  });

  it(`reads framed documents ${XSS_LIMITS.srcdocDepth} deep; deeper ones are not analysed`, () => {
    const nest = (depth: number, inner: string): string => (depth === 0 ? inner : `<iframe srcdoc="${nest(depth - 1, inner).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`);
    expect(xssOracle(nest(XSS_LIMITS.srcdocDepth, `<script>${M}</script>`), M).executes).toBe(true);
    expect(xssOracle(nest(XSS_LIMITS.srcdocDepth + 1, `<script>${M}</script>`), M)).toMatchObject({ executes: false, limited: 'srcdoc' });
  });

  it(`reports at most ${XSS_LIMITS.sinks} sinks`, () => {
    const v = xssOracle(`<img src=x onerror=${M}>`.repeat(XSS_LIMITS.sinks + 10), M);
    expect(v.executes).toBe(true);
    expect(v.sinks).toHaveLength(XSS_LIMITS.sinks);
  });

  it('skips the round trip when the serialization would exceed the parse budget (escaping can grow it 6x)', () => {
    const quotes = `<img src=x onerror=${M}><a title='${'"'.repeat(XSS_LIMITS.htmlLength - 80)}'>x</a>`;
    expect(xssOracle(quotes, M)).toMatchObject({ executes: true, mxss: false, limited: 'budget' });
  });

  it('the verdict and its sinks are frozen', () => {
    const v = xssOracle(`<img src=x onerror=${M}>`, M);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.sinks)).toBe(true);
    expect(Object.isFrozen(v.sinks[0])).toBe(true);
  });

  // The worst inputs measured for parse5 at the caps (one tag with thousands of distinct attributes is quadratic in
  // the tokenizer; deep and misnested trees are quadratic in scope checks, bounded by the tag cap). Each is far under
  // this bound (tens of ms); the bound only catches a regression by orders of magnitude. The test's own budget is
  // generous because other suites may share the CPU.
  it('worst-case inputs at the caps finish in bounded time', { timeout: 60_000 }, () => {
    const cap = XSS_LIMITS.htmlLength;
    let k = 0;
    const attrs = (sep: string, len = cap - 12) => { let s = '<a'; while (s.length < len) s += `${sep}${(k++).toString(36)}`; return `${s}>`; };
    const upTo = (unit: string, prefix = '') => { let s = prefix; let tags = 0; while (s.length + unit.length <= cap && tags + 2 <= XSS_LIMITS.tags) { s += unit; tags += (unit.match(/</g) ?? []).length; } return s; };
    const worst = [
      attrs(' '), attrs('/'), `<noscript>${attrs(' ', cap - 24)}`, upTo('<div>'), upTo('<div>', '<table>'), upTo('<i c=1>'),
      upTo('<i></p>x'), upTo('<h1><h2>'), upTo('<li>'), upTo('<template>'), upTo('<math><mtext>'), upTo('<!---->'),
      `<iframe srcdoc="${attrs(' ', cap - 40)}"></iframe>`,
    ];
    for (const html of worst) {
      expect(html.length).toBeLessThanOrEqual(cap);
      const t = performance.now();
      xssOracle(html, M);
      xssOracle(html, M, { insertion: 'innerHTML' });
      expect(performance.now() - t, html.slice(0, 40)).toBeLessThan(4000);
    }
  });
});

describe('linkSinks: links and resources a mail client or page would request (no script)', () => {
  it('lists every URL in document order, entity-decoded and trimmed as a URL parser does', () => {
    const html = [
      '<a href=" http://attacker.test/a\n ">click</a>', '<img src="http://attacker.test/i.png">',
      '<img srcset="http://attacker.test/1x.png 1x, http://attacker.test/2x.png 2x">', '<form action="http://attacker.test/f"><button>go</button></form>',
      '<div style="background:url(&quot;http://attacker.test/bg&quot;)">x</div>', '<style>@import "http://attacker.test/s.css"; p{background:url(http://attacker.test/p)}</style>',
      '<link rel=stylesheet href="http://attacker.test/l.css">', '<svg><a xlink:href="http://attacker.test/svg-a"><text>x</text></a><image href="http://attacker.test/svg-i"/></svg>',
      '<iframe src="http://attacker.test/frame"></iframe>', '<table background="http://attacker.test/t"><tr><td>x</td></tr></table>',
      '<template><img src="http://attacker.test/inert"></template>',
      '<area href="&#104;ttp://attacker.test/area">',
    ].join('');
    expect(linkSinks(html).map((l) => [l.kind, l.element, l.attribute, l.url, l.trigger])).toEqual([
      ['link', 'a', 'href', 'http://attacker.test/a', 'interaction'],
      ['resource', 'img', 'src', 'http://attacker.test/i.png', 'load'],
      ['resource', 'img', 'srcset', 'http://attacker.test/1x.png', 'load'],
      ['resource', 'img', 'srcset', 'http://attacker.test/2x.png', 'load'],
      ['link', 'form', 'action', 'http://attacker.test/f', 'interaction'],
      ['resource', 'div', 'style', 'http://attacker.test/bg', 'load'],
      ['resource', 'style', '', 'http://attacker.test/s.css', 'load'],
      ['resource', 'style', '', 'http://attacker.test/p', 'load'],
      ['resource', 'link', 'href', 'http://attacker.test/l.css', 'load'],
      ['link', 'svg:a', 'xlink:href', 'http://attacker.test/svg-a', 'interaction'],
      ['resource', 'svg:image', 'href', 'http://attacker.test/svg-i', 'load'],
      ['resource', 'iframe', 'src', 'http://attacker.test/frame', 'load'],
      ['resource', 'table', 'background', 'http://attacker.test/t', 'load'],
      ['link', 'area', 'href', 'http://attacker.test/area', 'interaction'],
    ]);
  });

  it('parses as a mail client does (scripting off: noscript content is markup); scripting: true parses as a page', () => {
    const html = '<noscript><img src="http://attacker.test/pixel"></noscript>';
    expect(linkSinks(html).map((l) => l.url)).toEqual(['http://attacker.test/pixel']);
    expect(linkSinks(html, { scripting: true })).toEqual([]);
  });

  it('escaped markup is no link; an over-cap page has none', () => {
    expect(linkSinks('&lt;a href="http://attacker.test/"&gt;x&lt;/a&gt;')).toEqual([]);
    expect(linkSinks(`<a href="http://attacker.test/">x</a>`.padEnd(XSS_LIMITS.htmlLength + 1, 'x'))).toEqual([]);
  });

  it(`lists at most ${XSS_LIMITS.sinks} URLs, each frozen`, () => {
    const links = linkSinks('<a href="http://attacker.test/x">x</a>'.repeat(XSS_LIMITS.sinks + 5));
    expect(links).toHaveLength(XSS_LIMITS.sinks);
    expect(Object.isFrozen(links) && Object.isFrozen(links[0])).toBe(true);
  });
});

// --- The sandboxed preview: the player watches the payload fire, in a frame that cannot touch the platform ----------

type P5Element = DefaultTreeAdapterTypes.Element;
const elementsOf = (nodes: readonly DefaultTreeAdapterTypes.ChildNode[]): P5Element[] => nodes.filter((n): n is P5Element => 'tagName' in n);
const textIn = (el: P5Element): string => el.childNodes.map((c) => ('value' in c ? c.value : '')).join('');
/** previewFrame's output as a browser parses it: the frame element, its attributes, and its srcdoc document. */
function frameOf(html: string) {
  const top = elementsOf(parseFragment(html).childNodes);
  expect(top.map((e) => e.tagName), html).toEqual(['iframe']);
  const attrs: Record<string, string> = Object.fromEntries(top[0].attrs.map((a) => [a.name, a.value]));
  const doc = parse(attrs.srcdoc ?? '');
  const [root] = elementsOf(doc.childNodes);
  const [head, body] = elementsOf(root.childNodes);
  return { attrs, srcdoc: attrs.srcdoc ?? '', head, body };
}

describe('previewFrame: the payload runs for the player in an opaque origin', () => {
  it('is one iframe with sandbox="allow-scripts" (never allow-same-origin), no src, no referrer', () => {
    const out = previewFrame('<p>hello</p>', { marker: M });
    const { attrs } = frameOf(out);
    expect(Object.keys(attrs).sort()).toEqual(['class', 'referrerpolicy', 'sandbox', 'srcdoc', 'title']);
    expect(attrs.sandbox).toBe('allow-scripts');
    expect(PREVIEW_SANDBOX).toBe('allow-scripts');
    expect(attrs.referrerpolicy).toBe('no-referrer');
    expect(out).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  });

  it('carries the fragment byte for byte in its body, after the CSP and the hvwa() shim in its head', () => {
    const fragment = '<b class="x">Results for <i>a&amp;b</i></b>é <img src=x onerror="hvwa(\'1\')">';
    const { srcdoc, head, body } = frameOf(previewFrame(fragment, { marker: M }));
    expect(srcdoc.endsWith(`<body>${fragment}</body></html>`)).toBe(true);
    expect(elementsOf(head.childNodes).map((e) => e.tagName)).toEqual(['meta', 'meta', 'style', 'script']);
    const csp = elementsOf(head.childNodes)[1];
    expect(Object.fromEntries(csp.attrs.map((a) => [a.name, a.value]))).toEqual({ 'http-equiv': 'Content-Security-Policy', content: PREVIEW_CSP });
    expect(PREVIEW_CSP).toMatch(/default-src 'none'/);
    expect(PREVIEW_CSP).toMatch(/form-action 'none'/);
    expect(PREVIEW_CSP).not.toMatch(/connect-src|'self'|http/); // no request leaves the frame, not even to the lab
    expect(elementsOf(body.childNodes).map((e) => e.tagName)).toEqual(['b', 'img']);
  });

  it('cannot be broken out of: whatever the fragment, the platform page gets one inert iframe', () => {
    for (const fragment of [
      '"><script>alert(1)</script>', "'><script>alert(1)</script>", '</iframe><script>alert(1)</script>', '&quot;><img src=x onerror=alert(1)>',
      ' onload=alert(1) x="', '<!--', ']]>', '<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>',
    ]) {
      const out = previewFrame(fragment);
      const { srcdoc } = frameOf(out);
      expect(srcdoc.endsWith(`<body>${fragment}</body></html>`), fragment).toBe(true);
      expect(out.indexOf('<'), fragment).toBe(0);
      expect(out.slice(1, -'</iframe>'.length).includes('<'), fragment).toBe(false); // the srcdoc is all escaped
    }
  });

  it('the oracle certifies it: payloads that run on a page run only isolated in the preview', () => {
    for (const payload of [
      `<script>${M}</script>`, `<img src=x onerror=${M}>`, `<svg onload=${M}>`, `<a href="javascript:${M}">x</a>`,
      `<iframe srcdoc="<script>${M}</script>"></iframe>`, `<iframe sandbox="allow-scripts allow-same-origin" srcdoc="<script>${M}</script>"></iframe>`,
    ]) {
      expect(xssOracle(payload, M).executes, payload).toBe(true);
      const v = xssOracle(previewFrame(payload, { marker: M }), M);
      expect(v.executes, payload).toBe(false);
      expect(v.sinks.filter((x) => x.marker).length, payload).toBeGreaterThan(0);
      expect(v.sinks.every((x) => x.isolated), payload).toBe(true);
    }
  });

  it('defines hvwa() (and alert/confirm/prompt) inside the frame to show a banner, naming the player\'s own marker', () => {
    const { head } = frameOf(previewFrame('<p>x</p>', { marker: M }));
    const code = textIn(elementsOf(head.childNodes)[3]);
    expect(code).toContain('window.hvwa=');
    expect(code).toContain('window.alert=');
    expect(code).toContain(JSON.stringify(N));
    expect(code).toContain('textContent'); // the banner is text, never markup
    expect(code).not.toMatch(/innerHTML|document\.write|eval|Function\(/);
    expect(xssOracle(previewFrame('<p>x</p>', { marker: M }), M).sinks.some((x) => x.marker)).toBe(false); // the shim calls no marker
    expect(() => previewFrame('<p>x</p>', { marker: 'alert(1)' })).toThrow(/marker/);
  });

  it('a DOM-XSS lab can set location.hash in the frame first; the hash cannot end the shim script', () => {
    const hash = '#</script><script>alert(1)</script>';
    const { head, body } = frameOf(previewFrame('<p>x</p>', { hash }));
    expect(elementsOf(head.childNodes).map((e) => e.tagName)).toEqual(['meta', 'meta', 'style', 'script']);
    expect(elementsOf(body.childNodes).map((e) => e.tagName)).toEqual(['p']);
    const code = textIn(elementsOf(head.childNodes)[3]);
    expect(code).toContain('location.hash=');
    expect(code).not.toContain('</script');
  });

  it('escapes its title, and omits a fragment over the oracle\'s size cap (nothing the oracle would not judge)', () => {
    expect(frameOf(previewFrame('<p>x</p>', { title: '"><b>t' })).attrs.title).toBe('"><b>t');
    expect(frameOf(previewFrame('<p>x</p>')).attrs.title).toBe('Sandboxed preview');
    const big = `<img src=x onerror=${M}>`.padEnd(XSS_LIMITS.htmlLength + 1, 'x');
    const { srcdoc, body } = frameOf(previewFrame(big));
    expect(srcdoc).not.toContain(M);
    expect(elementsOf(body.childNodes).map(textIn).join('')).toMatch(/Preview omitted/);
    expect(previewFrame(undefined as never)).toContain('srcdoc=');
  });
});

// --- The no-network guard, extended to core/xss/ ------------------------------------------------------------------

const XSS_DIR = new URL('../src/core/xss/', import.meta.url);
const XSS_FILES = readdirSync(XSS_DIR).filter((f) => f.endsWith('.ts')).sort();
/** What core/xss/ may import at runtime: parse5, the sim's copying clip, and its own files. Type-only imports are erased. */
const XSS_ALLOWED_IMPORTS: ReadonlySet<string> = new Set(['parse5', '../sim/limits.js', ...XSS_FILES.map((f) => `./${f.replace(/\.ts$/, '.js')}`)]);
/** Globals that reach the network, the file system or load code, however the call site spells the rest. */
const DENIED_GLOBALS: ReadonlySet<string> = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'globalThis', 'global', 'window', 'self', 'process', 'require',
  'module', 'eval', 'Function', 'Deno', 'Bun', 'importScripts', 'Worker', 'WebAssembly',
]);

/** A module's runtime imports, and what it must never do (dynamic import, require, a denied global), parsed by tsc. */
function sourceCheck(src: string, kind = ts.ScriptKind.TS): { runtime: string[]; problems: string[] } {
  const sf = ts.createSourceFile('m.ts', src, ts.ScriptTarget.Latest, true, kind);
  const runtime: string[] = [];
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) runtime.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) runtime.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push('import = require');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push('dynamic import()');
    } else if (ts.isIdentifier(node) && DENIED_GLOBALS.has(node.text)) {
      problems.push(`${node.text} (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { runtime, problems };
}

/** Every module a set of entry files loads at runtime, transitively through relative imports, and the bare imports. */
function closure(entries: readonly URL[], kind = ts.ScriptKind.TS): { files: string[]; outside: string[]; problems: string[] } {
  const seen = new Set<string>();
  const outside = new Set<string>();
  const problems: string[] = [];
  const walk = (file: URL): void => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    const check = sourceCheck(readFileSync(file, 'utf8'), kind);
    problems.push(...check.problems.map((p) => `${file.pathname.split('/').slice(-2).join('/')}: ${p}`));
    for (const m of check.runtime) {
      if (m.startsWith('.')) walk(new URL(kind === ts.ScriptKind.TS ? m.replace(/\.js$/, '.ts') : m, file));
      else outside.add(m);
    }
  };
  for (const e of entries) walk(e);
  return { files: [...seen].sort(), outside: [...outside].sort(), problems };
}

describe('no player code runs, and core/xss/ reaches no network, file system or code loader', () => {
  it('the guard flags every way to reach a module or a global it does not allow (self-test)', () => {
    const evasions = [
      "import 'node:http';", "import * as f from 'node:fs';", "import { runInNewContext } from 'node:vm';", "import cp from 'node:child_process';",
      'const m = await import(`node:http`);', "export * from 'node:tls';", "import d = require('node:dns');", "const r = require('node:net');",
      "globalThis['fe' + 'tch']('http://x');", "fetch('http://x');", 'process.binding("tcp_wrap");', "(0, eval)('1');", "Function('return this')();",
      "new Worker('x.js');", 'WebAssembly.instantiate(b);', "import { request } from 'undici';", "import x from '../render.js';", "import x from '../sim/url.js';",
    ];
    for (const src of evasions) {
      const { runtime, problems } = sourceCheck(src);
      expect([...runtime.filter((m) => !XSS_ALLOWED_IMPORTS.has(m)), ...problems], src).not.toEqual([]);
    }
    expect(sourceCheck("import type { SimWorld } from '../sim/world.js'; import { parse } from 'parse5';")).toEqual({ runtime: ['parse5'], problems: [] });
  });

  it('src/core/xss/ imports only parse5, the copying clip and its own files; no dynamic loading, no denied global', () => {
    expect(XSS_FILES).toEqual(['limits.ts', 'marker.ts', 'oracle.ts', 'preview.ts', 'rules.ts']);
    for (const file of XSS_FILES) {
      const { runtime, problems } = sourceCheck(readFileSync(new URL(file, XSS_DIR), 'utf8'));
      expect(runtime.filter((m) => !XSS_ALLOWED_IMPORTS.has(m)), file).toEqual([]);
      expect(problems, file).toEqual([]);
    }
  });

  it('everything src/core/xss/ loads at runtime, transitively, is its own files, sim/limits.ts, parse5 and node:buffer', () => {
    const { files, outside, problems } = closure(XSS_FILES.map((f) => new URL(f, XSS_DIR)));
    expect(problems).toEqual([]);
    expect(outside).toEqual(['node:buffer', 'parse5']);
    const core = new URL('../src/core/', import.meta.url).href;
    expect(files.map((h) => h.slice(core.length))).toEqual(['sim/limits.ts', ...XSS_FILES.map((f) => `xss/${f}`)].sort());
  });

  it('parse5 and entities, as installed, import nothing but each other: no node: builtin at all', () => {
    const require = createRequire(import.meta.url);
    const parse5 = new URL(`file:///${require.resolve('parse5').replace(/\\/g, '/')}`);
    const fromParse5 = createRequire(parse5);
    const entityEntries = ['entities/decode', 'entities/escape'].map((e) => new URL(`file:///${fromParse5.resolve(e).replace(/\\/g, '/')}`));
    const p5 = closure([parse5], ts.ScriptKind.JS);
    expect(p5.outside).toEqual(['entities/decode', 'entities/escape']);
    expect(p5.problems).toEqual([]);
    const ent = closure(entityEntries, ts.ScriptKind.JS);
    expect(ent.outside).toEqual([]);
    expect(ent.problems).toEqual([]);
    expect(p5.files.length + ent.files.length).toBeGreaterThan(10); // the walk really followed the dist files
  });

  it('core/sim/ never reaches core/xss/ (the victim wrap lives in core/victim.ts, outside the sim guard)', () => {
    const simDir = new URL('../src/core/sim/', import.meta.url);
    const sim = closure(readdirSync(simDir).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, simDir)));
    expect(sim.files.filter((f) => f.includes('/core/xss'))).toEqual([]);
    expect(sim.outside).not.toContain('parse5');
  });

  it('an oracle run touches no network function', () => {
    const require = createRequire(import.meta.url);
    const on = (id: string, fns: readonly string[]) => fns.map((f) => vi.spyOn(require(id) as Record<string, () => unknown>, f));
    const spies = [
      vi.spyOn(globalThis, 'fetch'), ...on('node:http', ['request', 'get']), ...on('node:https', ['request', 'get']),
      ...on('node:net', ['connect', 'createConnection']), ...on('node:dns', ['lookup', 'resolve']), ...on('node:dgram', ['createSocket']),
    ];
    try {
      const page = `<img src="http://attacker.test/x" onerror=${M}><iframe src="http://attacker.test/f"></iframe><link rel=stylesheet href="http://attacker.test/s"><script src="http://attacker.test/x.js"></script>`;
      expect(xssOracle(page, M).executes).toBe(true);
      expect(linkSinks(page)).toHaveLength(4);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
