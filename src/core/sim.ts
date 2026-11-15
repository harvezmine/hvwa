// src/core/sim.ts — the simulated victim for victim-driven labs (reset emails the admin clicks, OAuth redirects,
// session links): two fictional hosts, a per-player inbox, the player's attacker-server log and a tiny browser.
//
// Deterministic, and NO real network: nothing here opens a socket, resolves a name or fetches. citadel.test
// requests are answered IN PROCESS by a handler the lab builds from its own level functions; attacker.test
// requests are appended to the player's log; every other host is unreachable. Labs that TEACH URL-parsing flaws
// do their own (flawed) checks in their level files: classifySimUrl() is the ground truth for where the victim's
// browser actually went.
import type { Level } from './levels.js';

/** The lab itself, as the victim's browser sees it: http://citadel.test/<path> is the lab route <labPath>/<path>. */
export const CITADEL_HOST = 'citadel.test';
/** The player's server: attacker.test and every subdomain of it (*.attacker.test), on any port. */
export const ATTACKER_HOST = 'attacker.test';
export const CITADEL_ORIGIN = `http://${CITADEL_HOST}`;
export const ATTACKER_ORIGIN = `http://${ATTACKER_HOST}`;

/** Bounds on everything the simulation stores per player and level (all of it is attacker-influenced). */
export const SIM_LIMITS = Object.freeze({
  /** Longest URL the browser follows, before and after WHATWG serialization (percent-encoding can grow it). */
  urlLength: 2048,
  /** Most redirects (3xx with Location, or a page's Refresh) one visit follows. */
  maxRedirects: 10,
});

/** Which simulated site a URL reaches. */
export type SimSite = 'citadel' | 'attacker' | 'other';
/** Why an `other` URL is unreachable. */
export type SimUnreachable = 'invalid' | 'too-long' | 'scheme' | 'ip' | 'port' | 'host';

/** classifySimUrl()'s answer. For `other` the URL fields are '' unless it parsed as http(s). */
export interface SimUrl {
  readonly site: SimSite;
  /** What a server would see: scheme://host[:port]/path?query. Userinfo and the fragment are never sent. */
  readonly url: string;
  /** scheme://host[:port], as WHATWG serializes it. */
  readonly origin: string;
  /** The host the browser connects to: lower case, IDNA-mapped, percent-decoded, one trailing dot removed. */
  readonly host: string;
  /** The path, percent-encoded, dot segments resolved ('/callback'). */
  readonly path: string;
  /** The raw query string with its '?', or ''. */
  readonly search: string;
  /** The parsed query (a fresh copy per call). */
  readonly query: URLSearchParams;
  /** Whether the URL carried userinfo (user[:password]@). It never decides the site and is never sent. */
  readonly userinfo: boolean;
  /** Why an `other` URL is unreachable; undefined for citadel and attacker. */
  readonly reason?: SimUnreachable;
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/; // WHATWG always serializes an IPv4 host as four decimal parts

function result(site: SimSite, u: URL | undefined, host: string, reason?: SimUnreachable): SimUrl {
  return Object.freeze({
    site,
    url: u ? `${u.protocol}//${u.host}${u.pathname}${u.search}` : '',
    origin: u ? u.origin : '',
    host,
    path: u ? u.pathname : '',
    search: u ? u.search : '',
    query: new URLSearchParams(u ? u.search : ''),
    userinfo: u ? u.username !== '' || u.password !== '' : false,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Where a URL takes the simulated victim's browser. Parsing is the WHATWG URL parser (the one browsers use), so
 * tricks resolve exactly as in a browser; no DNS is involved. In order:
 *
 *  1. Not a string, or longer than SIM_LIMITS.urlLength: `other` (`invalid` / `too-long`).
 *  2. `new URL(input, base)` (relative references need `base`, e.g. a Location header): a parse error is
 *     `other`/`invalid`. WHATWG strips surrounding spaces and inner tabs/newlines, treats `\` as `/` in http(s)
 *     URLs (`http://attacker.test\@citadel.test/` is attacker.test; `/\attacker.test` leaves the site), lower-cases
 *     the host, percent-decodes it and maps IDN per UTS #46 (full-width letters and `。` become ASCII; look-alike
 *     letters from other scripts become `xn--` labels, so never a sim host).
 *  3. A scheme other than http: / https: (`javascript:`, `data:`, `file:` ...): `other`/`scheme`.
 *  4. Serialized longer than SIM_LIMITS.urlLength: `other`/`too-long`.
 *  5. One trailing dot is dropped (`ATTACKER.TEST.` is attacker.test). An IPv4 or IPv6 literal (in any WHATWG
 *     spelling: `0x7f.1`, `2130706433`, `[::1]`): `other`/`ip`. Any empty label (`a..b`, `.x`, two trailing
 *     dots): `other`/`host`.
 *  6. Exactly `citadel.test`: `citadel` on the scheme's default port (80 / 443), else `other`/`port`. Its
 *     subdomains are NOT the citadel (`attacker.test.citadel.test` is `other`).
 *  7. `attacker.test` or any `*.attacker.test`, on any port: `attacker` (`citadel.test.attacker.test` too).
 *  8. Anything else (localhost, example.com ...): `other`/`host`.
 *
 * Userinfo never decides the site: `http://citadel.test@attacker.test/` goes to attacker.test, as in every
 * browser; it is dropped from `url` (servers never receive it) and reported as `userinfo: true`.
 */
export function classifySimUrl(input: string, base?: string): SimUrl {
  if (typeof input !== 'string') return result('other', undefined, '', 'invalid');
  if (input.length > SIM_LIMITS.urlLength) return result('other', undefined, '', 'too-long');
  let u: URL;
  try {
    u = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return result('other', undefined, '', 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return result('other', undefined, '', 'scheme');
  if (`${u.protocol}//${u.host}${u.pathname}${u.search}`.length > SIM_LIMITS.urlLength) {
    return result('other', undefined, '', 'too-long');
  }
  const host = u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname;
  if (host.startsWith('[') || IPV4_RE.test(host)) return result('other', u, host, 'ip');
  if (host.split('.').some((label) => label === '')) return result('other', u, host, 'host');
  if (host === CITADEL_HOST) return u.port === '' ? result('citadel', u, host) : result('other', u, host, 'port');
  if (host === ATTACKER_HOST || host.endsWith(`.${ATTACKER_HOST}`)) return result('attacker', u, host);
  return result('other', u, host, 'host');
}

/**
 * A citadel URL as a link into the real lab: `http://citadel.test/<path>?<query>` is `<base>/<path>?<query>`
 * with `level=<level>` set (replacing any level in the query). `base` is labPath(res). Undefined for any URL
 * that is not the citadel, so attacker or `javascript:` links are never turned into hrefs.
 */
export function labHref(u: SimUrl, base: string, level: Level): string | undefined {
  if (u.site !== 'citadel') return undefined;
  const q = new URLSearchParams(u.search);
  q.set('level', level);
  return `${base}${u.path === '/' ? '' : u.path}?${q.toString()}`;
}
