// src/core/sim/cross.ts — the browser rules for requests that cross sites (engine task E1): sites and Sec-Fetch-Site,
// the Origin header, and form bodies as a browser encodes them. Pure functions of their arguments: no state, no I/O.
// The SameSite rules live with the jar (cookies.ts); the navigation loop that applies all of them is browser.ts.
import type { SimUrl } from './url.js';

/** A referrer policy token (Referrer Policy spec). */
export type ReferrerPolicy = 'no-referrer' | 'no-referrer-when-downgrade' | 'same-origin' | 'origin' | 'strict-origin'
  | 'origin-when-cross-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';
const POLICIES: ReadonlySet<string> = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin',
  'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
]);

/** A Referrer-Policy value (or several): the last recognized token, or undefined (unknown tokens are ignored). */
export function parsePolicy(values: readonly string[] | undefined): ReferrerPolicy | undefined {
  let found: ReferrerPolicy | undefined;
  for (const token of (values ?? []).join(',').split(',')) {
    const p = token.trim().toLowerCase();
    if (POLICIES.has(p)) found = p as ReferrerPolicy;
  }
  return found;
}

/**
 * The Referer a request from page `from` to `to` carries under `policy` (Referrer Policy spec, without length
 * limits). `from.url` never carries userinfo or a fragment (classifySimUrl drops both).
 */
export function refererFor(from: SimUrl, to: SimUrl, policy: ReferrerPolicy): string | undefined {
  const full = from.url;
  const origin = `${from.origin}/`;
  const sameOrigin = from.origin === to.origin;
  const downgrade = from.url.startsWith('https:') && to.url.startsWith('http:');
  switch (policy) {
    case 'no-referrer': return undefined;
    case 'no-referrer-when-downgrade': return downgrade ? undefined : full;
    case 'same-origin': return sameOrigin ? full : undefined;
    case 'origin': return origin;
    case 'strict-origin': return downgrade ? undefined : origin;
    case 'origin-when-cross-origin': return sameOrigin ? full : origin;
    case 'strict-origin-when-cross-origin': return sameOrigin ? full : downgrade ? undefined : origin;
    case 'unsafe-url': return full;
  }
}

/**
 * A URL's site (scheme and registrable domain: "schemeful same-site"). Every sim host is a name under `.test`, which
 * no public suffix list names, so the registrable domain is the last two labels: `citadel.test`, and `attacker.test`
 * for every `*.attacker.test`.
 */
export function siteOf(u: SimUrl): string {
  const labels = u.host.split('.');
  return `${u.url.startsWith('https:') ? 'https' : 'http'}://${labels.slice(-2).join('.')}`;
}

/** The document that made a request, as Fetch sees it. */
export interface SimInitiator {
  /** Its origin, serialized: 'null' for an opaque one (a sandboxed frame, a `data:` document). */
  readonly origin: string;
  /** Its site (siteOf); '' for an opaque origin, which is same-site with nothing. */
  readonly site: string;
}

/** An initiator from a page URL; `opaque` for a sandboxed document inside it. */
export function initiatorOf(page: SimUrl, opaque = false): SimInitiator {
  return opaque ? { origin: 'null', site: '' } : { origin: page.origin, site: siteOf(page) };
}

/**
 * Sec-Fetch-Site over a request's URL list (Fetch Metadata): 'same-origin' while every URL is the initiator's origin,
 * 'same-site' once one is only its site, 'cross-site' once one is another site (and for an opaque initiator). A
 * redirect never makes it less cross.
 */
export function fetchSiteOf(init: SimInitiator, urls: readonly SimUrl[]): 'same-origin' | 'same-site' | 'cross-site' {
  if (init.origin === 'null') return 'cross-site';
  let value: 'same-origin' | 'same-site' = 'same-origin';
  for (const u of urls) {
    if (u.origin === init.origin) continue;
    if (siteOf(u) !== init.site) return 'cross-site';
    value = 'same-site';
  }
  return value;
}

/**
 * Whether a request's URL list has a redirect-tainted origin (Fetch): a redirect from one origin to another, where
 * the origin redirected from is not the initiator's. Such a request's Origin is serialized as 'null'.
 */
export function redirectTainted(init: SimInitiator, urls: readonly SimUrl[]): boolean {
  for (let i = 1; i < urls.length; i++) {
    if (urls[i].origin !== urls[i - 1].origin && init.origin !== urls[i - 1].origin) return true;
  }
  return false;
}

/**
 * The Origin header a request carries (Fetch "append a request Origin header"), or undefined for none:
 * - a CORS request (fetch() to another origin, any method): always, 'null' once redirect-tainted or from an opaque
 *   origin; the referrer policy does not apply;
 * - any other request with a method other than GET (a form POST): the initiator's origin, or 'null' when the
 *   referrer policy hides it (no-referrer; same-origin to another origin; a strict or legacy policy on an https page
 *   posting to http), when tainted, or from an opaque origin;
 * - a GET navigation (a link, a frame, a GET form): none.
 */
export function originHeader(opts: {
  readonly init: SimInitiator; readonly method: 'GET' | 'POST'; readonly cors: boolean; readonly target: SimUrl;
  readonly policy: ReferrerPolicy; readonly tainted: boolean;
}): string | undefined {
  const { init, method, cors, target, policy, tainted } = opts;
  if (cors) return tainted ? 'null' : init.origin;
  if (method === 'GET') return undefined;
  if (tainted || init.origin === 'null') return 'null';
  switch (policy) {
    case 'no-referrer': return 'null';
    case 'no-referrer-when-downgrade': case 'strict-origin': case 'strict-origin-when-cross-origin':
      return init.origin.startsWith('https:') && !target.url.startsWith('https:') ? 'null' : init.origin;
    case 'same-origin': return init.origin === target.origin ? init.origin : 'null';
    default: return init.origin;
  }
}

/** Form fields in document order: a record, or [name, value] pairs (a name may repeat). Non-string values are dropped. */
export type SimFormFields = Readonly<Record<string, string>> | readonly (readonly [string, string])[];

/** The form's fields as [name, value] pairs (strings only; anything else, or not a list or record, gives none). */
export function formEntries(form: SimFormFields): [string, string][] {
  if (form === null || typeof form !== 'object') return [];
  const pairs: readonly unknown[] = Array.isArray(form) ? form : Object.entries(form);
  const out: [string, string][] = [];
  for (const p of pairs) {
    if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') out.push([p[0], p[1]]);
  }
  return out;
}

/** The enctypes an HTML form knows. */
export type SimFormEnctype = 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain';
const ENCTYPES: ReadonlySet<string> = new Set<SimFormEnctype>(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

/** A form's enctype attribute, as HTML reads it: one of the three (ASCII case-insensitive), else urlencoded. */
export function formEnctype(value: unknown): SimFormEnctype {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  return ENCTYPES.has(v) ? (v as SimFormEnctype) : 'application/x-www-form-urlencoded';
}

/** The boundary a sim form uses for multipart/form-data (deterministic; lengthened until no field contains it). */
export const SIM_FORM_BOUNDARY = '----CitadelFormBoundary7MA4YWxkTrZu0gW';

const lines = (s: string): string => s.replace(/\r\n|\r|\n/g, '\r\n'); // HTML: every line break becomes CRLF

/**
 * A form body as a browser encodes it for `enctype` (HTML "constructing the entry list" and the three encoders), with
 * the Content-Type it is sent with: urlencoded (`a=1&b=x+y`), text/plain (`a=1\r\nb=x y\r\n`, unescaped: the classic
 * JSON-smuggling body) or multipart/form-data (names with `"`, CR and LF percent-escaped).
 */
export function encodeForm(entries: readonly (readonly [string, string])[], enctype: SimFormEnctype): { readonly type: string; readonly raw: string } {
  const pairs = entries.map(([k, v]) => [lines(k), lines(v)] as const);
  if (enctype === 'text/plain') return { type: 'text/plain', raw: pairs.map(([k, v]) => `${k}=${v}\r\n`).join('') };
  if (enctype === 'multipart/form-data') {
    let boundary = SIM_FORM_BOUNDARY;
    while (pairs.some(([k, v]) => k.includes(boundary) || v.includes(boundary))) boundary += 'x';
    const esc = (s: string): string => s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const parts = pairs.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v}\r\n`);
    return { type: `multipart/form-data; boundary=${boundary}`, raw: `${parts.join('')}--${boundary}--\r\n` };
  }
  return { type: 'application/x-www-form-urlencoded', raw: new URLSearchParams(pairs.map(([k, v]) => [k, v])).toString() };
}

/** A MIME type's essence: lower case, without parameters or surrounding whitespace. */
export function mimeEssence(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
}

/**
 * The form fields a request body gives the lab (SimRequest.body), as the app's own body parsers read them: an
 * urlencoded body's fields (express.urlencoded; a repeated name keeps its first value) and a JSON object's string
 * members (express.json); nothing for any other type (text/plain, multipart: the app parses neither). Null prototype.
 */
export function bodyFields(type: string, raw: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const essence = mimeEssence(type);
  if (essence === 'application/x-www-form-urlencoded') {
    for (const [k, v] of new URLSearchParams(raw)) if (!Object.hasOwn(out, k)) out[k] = v;
  } else if (essence === 'application/json') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return out; }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}
