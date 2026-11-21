// src/core/host-guard.ts — DNS-rebinding guard. A malicious website can point
// its own hostname at 127.0.0.1 and then drive HVWA from the victim's browser
// with same-origin access. The browser still sends the attacker's hostname in
// Host, so HVWA answers only to the loopback names (any port) plus
// HVWA_ALLOWED_HOSTS, and gives everything else 421 before any route runs.
import type { RequestHandler } from 'express';

/** Hostnames always allowed, on any port: what a local browser sends. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain-text body of the 421 (never echoes the rejected Host). */
export const MISDIRECTED_BODY = '421 Misdirected Request: HVWA only answers to localhost, 127.0.0.1 and [::1] ' +
  '(plus HVWA_ALLOWED_HOSTS). This blocks DNS-rebinding attacks; see docs/SECURITY.md.\n';

// host = "[" IPv6 "]" or a name without delimiters; then an optional :port.
const HOST_HEADER_RE = /^(\[[0-9a-z:.]+\]|[^\s:/?#@[\]\\]+)(?::(\d{1,5}))?$/i;

/**
 * The hostname in a Host header value: lowercased, port dropped, one trailing
 * root dot removed ('localhost.' -> 'localhost', as nginx's $host does). IPv6
 * literals keep their brackets ('[::1]:1337' -> '[::1]'). Returns undefined
 * if the header is missing or malformed.
 */
export function hostnameOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = HOST_HEADER_RE.exec(header.trim());
  if (!m) return undefined;
  if (m[2] !== undefined && Number(m[2]) > 65535) return undefined;
  const name = m[1].toLowerCase().replace(/\.$/, '');
  return name === '' ? undefined : name;
}

/** Plain-text body of the 400 for a duplicated Host (echoes neither value). */
export const DUPLICATE_HOST_BODY = '400 Bad Request: more than one Host header.\n';

/**
 * The hostname named by a request target. Returns null for origin-form
 * ('/path') and asterisk-form ('*'), which carry no authority. For
 * absolute-form ('http://name:port/path') it returns the authority's hostname,
 * parsed like Host. Returns undefined for anything malformed, a non-http(s)
 * scheme, or userinfo.
 */
export function targetHostname(url: string): string | null | undefined {
  if (url.startsWith('/') || url === '*') return null;
  const m = /^https?:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(url);
  if (!m) return undefined;
  return hostnameOf(m[1]); // '@' (userinfo) and empty authorities are malformed there
}

/** How many Host header lines the client actually sent (Node keeps only the first in req.headers). */
function hostHeaderCount(rawHeaders: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === 'host') n += 1;
  return n;
}

/**
 * Middleware: pass requests whose Host hostname is a loopback name, one of
 * `extraHostnames` (exact, case-insensitive) or accepted by `extraMatch`
 * (portal mode: instance hosts i-<id>.<domain>, which the range's edge router
 * then handles alone), and, for an absolute-form target (`GET http://name/...`,
 * which HTTP says overrides Host), whose target is allowed the same way.
 * Everything else, including a missing Host, gets 421. More than one Host
 * header gets 400: which one counts would be ambiguous. Only the raw Host
 * header counts, never req.hostname or X-Forwarded-Host: with `trust proxy`
 * those come from the client, and labs may use them as attack vectors
 * (host-header poisoning). Mounted first, so rejected requests get no session
 * cookie and reach no route. `extraMatch` gets the lower-cased, port-less name.
 */
export function hostGuard(extraHostnames: readonly string[] = [], extraMatch?: (hostname: string) => boolean): RequestHandler {
  const allowed = new Set([...LOOPBACK_HOSTNAMES, ...extraHostnames.map((h) => h.toLowerCase())]);
  const ok = (h: string) => allowed.has(h) || (extraMatch !== undefined && extraMatch(h));
  return (req, res, next) => {
    if (hostHeaderCount(req.rawHeaders) > 1) {
      res.status(400).type('text/plain').send(DUPLICATE_HOST_BODY);
      return;
    }
    const name = hostnameOf(req.headers.host);
    const target = targetHostname(req.originalUrl);
    const targetOk = target === null || (target !== undefined && ok(target));
    if (name !== undefined && ok(name) && targetOk) {
      next();
      return;
    }
    res.status(421).type('text/plain').send(MISDIRECTED_BODY);
  };
}
