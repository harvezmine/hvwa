// src/core/http.ts — route-scoped lab headers (owner decision Q4, docs/RECIPES.md section 4 "Lab headers"). A lab sets
// CSP, X-Frame-Options, frame-ancestors and CORS on its OWN response, per level, from a fixed allow-list. Nothing here
// is global: no middleware, no app setting, no state. Platform, portal and Divine pages stay exactly as they are unless a
// lab sets headers on its own route. The level decides the values (in its levels/*.ts, where View Source shows them);
// this module only checks and writes them.
//
// labHeaders(h) is the pure part (the header lines, for a citadel twin's SimResponse as much as for a real route);
// setLabHeaders(res, h) writes the same lines on this lab route's response.
import type { Response } from 'express';

/** CORS on one response, as the level decided it. */
export interface LabCors {
  /** Access-Control-Allow-Origin: an origin (a reflected one included), 'null' or '*'. */
  readonly allowOrigin?: string;
  /** Access-Control-Allow-Credentials: true. false or absent: no header. */
  readonly allowCredentials?: boolean;
  /** Vary: Origin (the answer depends on the request's Origin, so a cache must key on it). Added to any Vary already set. */
  readonly varyOrigin?: boolean;
}

/** The headers a lab may set on its own route. Anything else is refused. */
export interface LabHeaders {
  /** Content-Security-Policy: ONE policy (no comma), e.g. "script-src 'self'; object-src 'none'". */
  readonly csp?: string;
  /** The CSP `frame-ancestors` source list, e.g. "'none'" or "'self'": its own directive of the same policy. */
  readonly frameAncestors?: string;
  /** X-Frame-Options. */
  readonly xfo?: 'DENY' | 'SAMEORIGIN';
  readonly cors?: LabCors;
}

/** Every header name labHeaders can produce (the allow-list, as written on the wire). */
export const LAB_HEADER_NAMES: readonly string[] = Object.freeze([
  'Content-Security-Policy', 'X-Frame-Options', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Vary',
]);

const KEYS: ReadonlySet<string> = new Set(['csp', 'frameAncestors', 'xfo', 'cors']);
const CORS_KEYS: ReadonlySet<string> = new Set(['allowOrigin', 'allowCredentials', 'varyOrigin']);
const at = 'setLabHeaders';

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

function onlyKnown(o: Record<string, unknown>, known: ReadonlySet<string>, prefix: string): void {
  for (const k of Object.keys(o)) {
    if (!known.has(k)) throw new Error(`${at}: "${prefix}${k}" is not a lab header (allowed: ${[...known].map((x) => prefix + x).join(', ')})`);
  }
}

/** A policy value a lab wrote: a non-empty string of printable ASCII (CSP is ASCII; a CR or LF would split the header). */
function ascii(name: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${at}: ${name} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${at}: ${name} has a control character`);
  if (/[^ -~]/.test(v)) throw new Error(`${at}: ${name} must be printable ASCII`);
  return v.trim();
}

/**
 * The header lines for `h`, frozen, by their wire names (LAB_HEADER_NAMES). Pure: use it for the SimResponse of a
 * citadel twin, so both browsers get the same headers from one level decision. Throws (a lab bug) for an option outside
 * the allow-list, a value of the wrong type, a control character, a CSP with two policies, or frame-ancestors given
 * both inside `csp` and as `frameAncestors`. Every value is checked before anything is built.
 */
export function labHeaders(h: LabHeaders): Readonly<Record<string, string>> {
  if (!isObject(h)) throw new Error(`${at}: headers must be an object { csp?, frameAncestors?, xfo?, cors? }`);
  onlyKnown(h, KEYS, '');
  const out: Record<string, string> = {};
  const { csp, frameAncestors, xfo, cors } = h as Record<string, unknown>;
  let policy = csp === undefined ? undefined : ascii('csp', csp).replace(/[;\s]+$/, '');
  if (policy !== undefined && policy.includes(',')) throw new Error(`${at}: csp must be one policy (a comma starts a second one)`);
  if (frameAncestors !== undefined) {
    const sources = ascii('frameAncestors', frameAncestors);
    if (/[;,]/.test(sources)) throw new Error(`${at}: frameAncestors is one source list (no ; or ,)`);
    if (policy !== undefined && policy.split(';').some((d) => d.trim().toLowerCase().split(/\s+/)[0] === 'frame-ancestors')) {
      throw new Error(`${at}: frame-ancestors twice (in csp and as frameAncestors): say it once`);
    }
    policy = policy === undefined ? `frame-ancestors ${sources}` : `${policy}; frame-ancestors ${sources}`;
  }
  if (policy !== undefined) out['Content-Security-Policy'] = policy;
  if (xfo !== undefined) {
    if (xfo !== 'DENY' && xfo !== 'SAMEORIGIN') throw new Error(`${at}: xfo must be 'DENY' or 'SAMEORIGIN'`);
    out['X-Frame-Options'] = xfo;
  }
  if (cors !== undefined) {
    if (!isObject(cors)) throw new Error(`${at}: cors must be an object { allowOrigin?, allowCredentials?, varyOrigin? }`);
    onlyKnown(cors, CORS_KEYS, 'cors.');
    const { allowOrigin, allowCredentials, varyOrigin } = cors;
    if (allowOrigin !== undefined) {
      // The level's own decision, possibly a reflected request header: any value a header can carry (latin1, no controls).
      if (typeof allowOrigin !== 'string' || allowOrigin === '') throw new Error(`${at}: cors.allowOrigin must be a non-empty string`);
      if (/[\u0000-\u001f\u007f]/.test(allowOrigin)) throw new Error(`${at}: cors.allowOrigin has a control character`);
      if (/[^ -ÿ]/.test(allowOrigin)) throw new Error(`${at}: cors.allowOrigin has a character a header cannot carry`);
      out['Access-Control-Allow-Origin'] = allowOrigin;
    }
    if (allowCredentials !== undefined && typeof allowCredentials !== 'boolean') throw new Error(`${at}: cors.allowCredentials must be a boolean`);
    if (allowCredentials === true) out['Access-Control-Allow-Credentials'] = 'true';
    if (varyOrigin !== undefined && typeof varyOrigin !== 'boolean') throw new Error(`${at}: cors.varyOrigin must be a boolean`);
    if (varyOrigin === true) out.Vary = 'Origin';
  }
  return Object.freeze(out);
}

/**
 * Set a level's headers on THIS lab route's response (never globally): the lines labHeaders(h) makes, `Vary: Origin`
 * added to any Vary already set. Call it in the route, before the answer is sent; `{}` sets nothing.
 *
 * Throws (a lab bug, so the stack-free 500), having set nothing: off a lab route (no labPath: portal and platform pages
 * are never touched), once headers are sent, for anything labHeaders refuses, or when one of its headers is already on
 * the response (two decisions for one header are never merged or overwritten silently).
 *
 * A page that holds a previewFrame: the srcdoc frame inherits the page's CSP, so a policy without 'unsafe-inline'
 * blocks the preview's banner shim and every inline payload there, as a browser would. The XSS oracle evaluates only
 * CSP `sandbox` (docs/RECIPES.md section 13): a policy is defence in depth, never what makes a Divine level secure.
 */
export function setLabHeaders(res: Response, h: LabHeaders): void {
  const labPath: unknown = res.locals?.labPath;
  if (typeof labPath !== 'string' || !labPath.startsWith('/d/')) {
    throw new Error(`${at}: only on a lab route (res.locals.labPath), never on a platform or portal page`);
  }
  if (res.headersSent) throw new Error(`${at}: the headers are already sent`);
  const lines = labHeaders(h);
  for (const name of Object.keys(lines)) {
    if (name !== 'Vary' && res.getHeader(name) !== undefined) throw new Error(`${at}: ${name} is already set on this response`);
  }
  for (const [name, value] of Object.entries(lines)) {
    if (name === 'Vary') res.vary(value);
    else res.setHeader(name, value);
  }
}
