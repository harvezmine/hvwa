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

// ---------------------------------------------------------------------------------------------------------------
// fetch() from the attacker's page: what it may send without a preflight, and what it may read (CORS)

/** Request headers a page can never set: fetch() silently drops them (Fetch "forbidden request-header"). */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BAD_VALUE_RE = /[\0\r\n]/;

/**
 * `s` without the leading and trailing characters in `ws`. An index loop: a trim regex such as /^\s+|\s+$/ is
 * quadratic on a long run of spaces inside a page-made value.
 */
function trimOf(s: string, ws: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && ws.includes(s[a])) a++;
  while (b > a && ws.includes(s[b - 1])) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/**
 * The headers a page's fetch() call sets, as fetch() takes them: names lower-cased, values stripped of surrounding
 * whitespace, a name given twice (in any case) combined with ', ', and the forbidden ones (Cookie, Origin, Referer,
 * Host, `Sec-*`, `Proxy-*` ...) dropped, as the browser drops them. Undefined when fetch() would throw instead (a name
 * that is not a token, a value with NUL, CR or LF, a value that is not a string): nothing is sent.
 */
export function fetchHeaders(given: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = Object.create(null);
  if (given === undefined) return out;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return undefined;
  for (const [name, raw] of Object.entries(given)) {
    if (typeof raw !== 'string' || !TOKEN_RE.test(name)) return undefined;
    const value = trimOf(raw, '\t\n\r ');
    if (BAD_VALUE_RE.test(value)) return undefined;
    const key = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) continue;
    out[key] = Object.hasOwn(out, key) ? `${out[key]}, ${value}` : value;
  }
  return out;
}

/** Bytes a CORS-safelisted header value may not contain (Fetch "CORS-unsafe request-header byte"). */
const UNSAFE_BYTE_RE = /[\0-\x08\x0A-\x1F"():<>?@[\\\]{}\x7F]/;
const MIME_ESSENCE_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/** The content types a request without a preflight may carry (and an HTML form's three enctypes). */
export const SIMPLE_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

/**
 * Whether a header is CORS-safelisted (Fetch): Accept, Accept-Language, Content-Language, or a Content-Type of one of
 * the three simple types, each at most 128 bytes and free of the unsafe bytes. So `Content-Type: application/json`,
 * any custom header (`X-Requested-With`) and even `text/plain; charset="utf-8"` (a quote) are not. Range is treated as
 * not safelisted (no lab needs it).
 */
export function corsSafelisted(name: string, value: string): boolean {
  if (value.length > 128) return false;
  switch (name) {
    case 'accept': return !UNSAFE_BYTE_RE.test(value);
    case 'accept-language': case 'content-language': return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case 'content-type': {
      if (UNSAFE_BYTE_RE.test(value)) return false;
      const essence = mimeEssence(value);
      return MIME_ESSENCE_RE.test(essence) && SIMPLE_CONTENT_TYPES.has(essence);
    }
    default: return false;
  }
}

/**
 * Whether a cross-origin fetch() needs a CORS preflight (an OPTIONS the server must approve before the request is
 * sent): a method other than GET, HEAD or POST, or any header that is not CORS-safelisted. `headers` as fetchHeaders()
 * returns them (the Content-Type included).
 */
export function needsPreflight(method: string, headers: Readonly<Record<string, string>>): boolean {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return true;
  return Object.entries(headers).some(([name, value]) => !corsSafelisted(name, value));
}

/** Whether the attacker's page may read a cross-origin answer, and if not, why (CORS check, Fetch). */
export type SimCorsRead = 'readable' | 'no-allow-origin' | 'origin-mismatch' | 'wildcard-credentials' | 'no-allow-credentials';

const httpTrim = (s: string): string => trimOf(s, '\t ');

/**
 * The CORS check on one response to a request that carried `Origin: origin` (Fetch), with credentials ('include') or
 * without:
 * - no Access-Control-Allow-Origin: blocked;
 * - `*` lets a request WITHOUT credentials read, never one with them ('wildcard-credentials');
 * - otherwise it must be exactly the request's Origin, byte for byte (`null` matches `Origin: null`; two values, or
 *   another case, do not);
 * - with credentials, Access-Control-Allow-Credentials must also be exactly `true`.
 * `headers` by lower-case name, each a list of values (several are combined with ', ', as a browser reads them).
 */
export function corsCheck(headers: ReadonlyMap<string, readonly string[]>, origin: string, credentials: boolean): SimCorsRead {
  const allow = headers.get('access-control-allow-origin');
  if (allow === undefined) return 'no-allow-origin';
  const value = allow.map(httpTrim).join(', ');
  if (!credentials && value === '*') return 'readable';
  if (value !== origin) return value === '*' ? 'wildcard-credentials' : 'origin-mismatch';
  if (!credentials) return 'readable';
  return headers.get('access-control-allow-credentials')?.map(httpTrim).join(', ') === 'true' ? 'readable' : 'no-allow-credentials';
}
