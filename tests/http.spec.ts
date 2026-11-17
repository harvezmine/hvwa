// tests/http.spec.ts — route-scoped lab headers (core/http.ts, docs/RECIPES.md section 4 "Lab headers"): a lab sets CSP,
// X-Frame-Options, frame-ancestors and CORS on its OWN response, from an allow-list, and nothing else changes: not the
// lab's other routes, not another lab, not the portal, not the platform's own answers.
import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { LAB_HEADER_NAMES, labHeaders, setLabHeaders, type LabHeaders } from '../src/core/http.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';
import { previewFrame } from '../src/core/xss.js';
import { freshSession } from './helpers.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSP = "script-src 'self'; object-src 'none'";
const LAB = '/d/http-test/headers';
const view = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'http-headers.ejs');

// A fixture lab: its front page sets headers per level (only Divine adds a policy, as an XSS lab's Divine would); one
// route sets every kind; one sets none.
register(defineChallenge({
  id: 'XH-01', district: 'http-test', slug: 'headers', dir: process.cwd(),
  title: { id: 'Header', en: 'Headers' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: ['acolyte', 'divine'], hints: [],
  mount: (router) => {
    router.get('/', async (req, res) => {
      if (req.level === 'divine') setLabHeaders(res, { csp: CSP });
      await sendPage(res, view, { preview: previewFrame('<p>results</p>') });
    });
    router.get('/all', (_req, res) => {
      setLabHeaders(res, {
        csp: CSP, frameAncestors: "'none'", xfo: 'DENY',
        cors: { allowOrigin: 'http://attacker.test', allowCredentials: true, varyOrigin: true },
      });
      res.type('text/plain').send('all');
    });
    router.get('/none', (_req, res) => { res.type('text/plain').send('none'); });
    router.get('/twice', (_req, res) => {
      setLabHeaders(res, { csp: CSP });
      setLabHeaders(res, { csp: "default-src 'none'" }); // a second policy for the same header: refused, never overwritten
      res.send('unreachable');
    });
    router.get('/vary', (_req, res) => {
      res.vary('Accept-Language');
      setLabHeaders(res, { cors: { allowOrigin: 'null', varyOrigin: true } });
      res.type('text/plain').send('vary');
    });
    router.get('/throws', () => { throw new Error('lab bug'); });
  },
}));

/** Every header name the helper may set, lower case (supertest's res.headers keys). */
const ALL = ['content-security-policy', 'x-frame-options', 'access-control-allow-origin', 'access-control-allow-credentials'];
const noLabHeaders = (headers: Record<string, unknown>, label: string): void => {
  for (const h of ALL) expect(headers[h], `${label}: ${h}`).toBeUndefined();
  expect(String(headers.vary ?? ''), `${label}: vary`).not.toMatch(/origin/i);
};

/** A stand-in for an Express response: just what setLabHeaders touches. */
function fakeRes(locals: Record<string, unknown> = { labPath: LAB }, headersSent = false) {
  const set = new Map<string, string>();
  return {
    set,
    res: {
      locals, headersSent,
      getHeader: (n: string) => set.get(n.toLowerCase()),
      setHeader: (n: string, v: string) => { set.set(n.toLowerCase(), v); },
      vary: (f: string) => { set.set('vary', set.has('vary') ? `${set.get('vary')}, ${f}` : f); },
    } as unknown as Response,
  };
}

describe('labHeaders: the header lines a level decision makes (for the citadel twin and the real route alike)', () => {
  it('nothing asked, nothing set', () => {
    expect(labHeaders({})).toEqual({});
    expect(labHeaders({ csp: undefined, cors: {} })).toEqual({});
  });

  it('a CSP, as written', () => {
    expect(labHeaders({ csp: CSP })).toEqual({ 'Content-Security-Policy': CSP });
  });

  it('frame-ancestors is its own directive of the same policy: alone, or appended to the CSP (a trailing ; tolerated)', () => {
    expect(labHeaders({ frameAncestors: "'none'" })).toEqual({ 'Content-Security-Policy': "frame-ancestors 'none'" });
    expect(labHeaders({ csp: CSP, frameAncestors: "'self'" })).toEqual({ 'Content-Security-Policy': `${CSP}; frame-ancestors 'self'` });
    expect(labHeaders({ csp: `${CSP}; `, frameAncestors: "'none'" })).toEqual({ 'Content-Security-Policy': `${CSP}; frame-ancestors 'none'` });
  });

  it('X-Frame-Options: DENY or SAMEORIGIN', () => {
    expect(labHeaders({ xfo: 'DENY' })).toEqual({ 'X-Frame-Options': 'DENY' });
    expect(labHeaders({ xfo: 'SAMEORIGIN' })).toEqual({ 'X-Frame-Options': 'SAMEORIGIN' });
  });

  it('CORS: the origin as the level decided (a reflected one, null, *), credentials only when true, Vary: Origin when asked', () => {
    expect(labHeaders({ cors: { allowOrigin: 'http://attacker.test', allowCredentials: true, varyOrigin: true } })).toEqual({
      'Access-Control-Allow-Origin': 'http://attacker.test', 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
    });
    expect(labHeaders({ cors: { allowOrigin: 'null' } })).toEqual({ 'Access-Control-Allow-Origin': 'null' });
    expect(labHeaders({ cors: { allowOrigin: '*', allowCredentials: false } })).toEqual({ 'Access-Control-Allow-Origin': '*' });
    // A misconfiguration a lab may teach (the browser refuses the credentialed read): allowed, not "fixed" here.
    expect(labHeaders({ cors: { allowOrigin: '*', allowCredentials: true } }))
      .toEqual({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' });
  });

  it('the answer is frozen, and names only allow-listed headers', () => {
    const h = labHeaders({ csp: CSP, frameAncestors: "'none'", xfo: 'DENY', cors: { allowOrigin: 'http://a.test', allowCredentials: true, varyOrigin: true } });
    expect(Object.isFrozen(h)).toBe(true);
    for (const name of Object.keys(h)) expect(LAB_HEADER_NAMES).toContain(name);
    expect(Object.isFrozen(LAB_HEADER_NAMES)).toBe(true);
  });
});

describe('labHeaders refuses anything outside the allow-list, and malformed values (a lab bug: it throws)', () => {
  const refuses = (h: unknown, re: RegExp) => { expect(() => labHeaders(h as LabHeaders)).toThrow(re); };

  it('an unknown option, at the top or in cors, is named', () => {
    refuses({ 'Set-Cookie': 'a=b' }, /"Set-Cookie" is not a lab header/);
    refuses({ headers: { 'X-Powered-By': 'x' } }, /"headers" is not a lab header/);
    refuses({ hsts: 'max-age=1' }, /"hsts" is not a lab header/);
    refuses({ cors: { allowMethods: 'GET' } }, /cors\.allowMethods" is not a lab header/);
    refuses({ cors: { allowHeaders: 'X-A', allowOrigin: '*' } }, /cors\.allowHeaders/);
  });

  it('not an object', () => {
    for (const h of [null, undefined, 'csp', 1, ['csp']]) refuses(h, /setLabHeaders: headers must be an object/);
    refuses({ cors: null }, /cors must be an object/);
    refuses({ cors: 'http://a.test' }, /cors must be an object/);
  });

  it('a CSP that is blank, not a string, two policies, or carries a control character', () => {
    for (const csp of ['', '   ', 1, true, {}]) refuses({ csp }, /csp must be a non-empty string/);
    refuses({ csp: "script-src 'self', default-src 'none'" }, /one policy/);
    for (const c of ['\r', '\n', '\u0000', '\u0007', '\u007f']) refuses({ csp: `script-src 'self'${c}x` }, /control character/);
    refuses({ csp: "script-src 'self' ✓" }, /ASCII/);
  });

  it('frame-ancestors given twice (in the CSP and as its own option), or as more than one directive', () => {
    refuses({ csp: "frame-ancestors 'self'", frameAncestors: "'none'" }, /frame-ancestors twice/);
    refuses({ csp: "default-src 'none'; FRAME-ANCESTORS 'self'", frameAncestors: "'none'" }, /frame-ancestors twice/);
    refuses({ frameAncestors: "'none'; script-src *" }, /one source list/);
    refuses({ frameAncestors: "'none', 'self'" }, /one source list/);
    refuses({ frameAncestors: '' }, /frameAncestors must be a non-empty string/);
  });

  it('X-Frame-Options other than DENY or SAMEORIGIN (ALLOW-FROM is obsolete; spelled exactly)', () => {
    for (const xfo of ['ALLOW-FROM http://a.test', 'deny', 'SameOrigin', '', 1]) refuses({ xfo }, /xfo must be 'DENY' or 'SAMEORIGIN'/);
  });

  it('CORS values of the wrong type, or an origin no header can carry', () => {
    refuses({ cors: { allowOrigin: '' } }, /allowOrigin must be a non-empty string/);
    refuses({ cors: { allowOrigin: 1 } }, /allowOrigin must be a non-empty string/);
    refuses({ cors: { allowOrigin: 'http://a.test\r\nSet-Cookie: x=1' } }, /control character/);
    refuses({ cors: { allowOrigin: 'http://✓.test' } }, /cannot carry/);
    refuses({ cors: { allowOrigin: '*', allowCredentials: 'true' } }, /allowCredentials must be a boolean/);
    refuses({ cors: { varyOrigin: 1 } }, /varyOrigin must be a boolean/);
  });
});

describe('setLabHeaders: on this lab route\'s own response only', () => {
  it('sets exactly what labHeaders makes', () => {
    const { res, set } = fakeRes();
    setLabHeaders(res, { csp: CSP, xfo: 'SAMEORIGIN', cors: { allowOrigin: 'http://a.test', varyOrigin: true } });
    expect(Object.fromEntries(set)).toEqual({
      'content-security-policy': CSP, 'x-frame-options': 'SAMEORIGIN', 'access-control-allow-origin': 'http://a.test', vary: 'Origin',
    });
  });

  it('refuses a response that is not a lab route (portal and platform pages are never touched)', () => {
    for (const locals of [{}, { labPath: '' }, { labPath: '/portal' }, { labPath: 7 }]) {
      const { res, set } = fakeRes(locals);
      expect(() => setLabHeaders(res, { csp: CSP })).toThrow(/only on a lab route/);
      expect(set.size).toBe(0);
    }
  });

  it('refuses once the headers are sent', () => {
    const { res, set } = fakeRes({ labPath: LAB }, true);
    expect(() => setLabHeaders(res, { csp: CSP })).toThrow(/headers are already sent/);
    expect(set.size).toBe(0);
  });

  it('a refused call sets nothing at all (every value is checked before the first header)', () => {
    const { res, set } = fakeRes();
    expect(() => setLabHeaders(res, { csp: CSP, xfo: 'deny' as 'DENY' })).toThrow(/xfo/);
    expect(set.size).toBe(0);
  });

  it('never overwrites a header already on the response (two decisions for one header is a lab bug)', () => {
    const { res, set } = fakeRes();
    res.setHeader('X-Frame-Options', 'DENY');
    expect(() => setLabHeaders(res, { csp: CSP, xfo: 'SAMEORIGIN' })).toThrow(/X-Frame-Options is already set/);
    expect(Object.fromEntries(set)).toEqual({ 'x-frame-options': 'DENY' });
  });
});

describe('setLabHeaders over HTTP: route-scoped, nothing global', () => {
  it('the lab route carries its headers; its other routes, other labs, the portal and the platform carry none', async () => {
    const { agent } = await freshSession();
    const all = await agent.get(`${LAB}/all?level=acolyte`);
    expect(all.status).toBe(200);
    expect(all.headers['content-security-policy']).toBe(`${CSP}; frame-ancestors 'none'`);
    expect(all.headers['x-frame-options']).toBe('DENY');
    expect(all.headers['access-control-allow-origin']).toBe('http://attacker.test');
    expect(all.headers['access-control-allow-credentials']).toBe('true');
    expect(all.headers.vary).toMatch(/Origin/);
    // ...and right after it, nothing leaks anywhere else, in the same app and the same session.
    for (const url of [`${LAB}/none?level=acolyte`, `${LAB}?level=acolyte`, '/', '/healthz', '/c/XH-01', '/nope', '/scoreboard']) {
      noLabHeaders((await agent.get(url)).headers, url);
    }
  });

  it('per level: the Divine front page has its CSP, the Acolyte one has none', async () => {
    const { agent } = await freshSession();
    expect((await agent.get(`${LAB}?level=divine`)).headers['content-security-policy']).toBe(CSP);
    noLabHeaders((await agent.get(`${LAB}?level=acolyte`)).headers, 'acolyte');
    expect((await agent.get(`${LAB}?level=divine`)).headers['content-security-policy']).toBe(CSP);
  });

  it('a second policy for the same header is a lab bug (500), never a silent overwrite', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/twice?level=acolyte`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('unreachable');
  });

  it('Vary: Origin is added to a Vary the route already set, not over it', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/vary?level=acolyte`);
    expect(res.headers.vary).toBe('Accept-Language, Origin');
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });

  it('a lab page keeps working under script-src \'self\': the platform layout has no inline script or handler (htmx is a file)', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=divine`);
    expect(res.headers['content-security-policy']).toBe(CSP);
    const scripts: { src?: string }[] = [];
    const handlers: string[] = [];
    const walk = (n: unknown): void => {
      const node = n as { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[]; content?: { childNodes: unknown[] } };
      if (node.tagName === 'script') scripts.push({ src: node.attrs?.find((a) => a.name === 'src')?.value });
      for (const a of node.attrs ?? []) if (/^on/i.test(a.name)) handlers.push(`${node.tagName} ${a.name}`);
      for (const c of [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])]) walk(c);
    };
    walk(parse(res.text));
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s.src, 'an inline script on the lab page').toMatch(/^\/static\//);
    expect(handlers).toEqual([]);
    // The preview is still there: a srcdoc frame inherits the page's policy, so its inline shim and payloads obey it.
    expect(res.text).toContain('<iframe class="xss-preview" sandbox="allow-scripts"');
  });

  it('an error page after a lab route throws carries no lab header it did not set', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/throws?level=acolyte`);
    expect(res.status).toBe(500);
    noLabHeaders(res.headers, 'error page');
  });
});
