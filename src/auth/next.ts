// src/auth/next.ts — where the login page may send the browser afterwards (?next= / the form's `next`).
// PLATFORM code: an open redirect here would turn the lab's own login into a phishing hop. Only a
// same-origin LOCAL path is accepted; anything doubtful becomes '/'.

/** Longest `next` kept (a lab URL with its query fits easily). */
export const MAX_NEXT_LENGTH = 2048;

// Printable ASCII without space or backslash. Browsers send a URL's path and query percent-encoded, so
// anything else (CR/LF, tabs, NUL, Unicode look-alike slashes) is not a link a page of ours produced.
const PRINTABLE = /^[\x21-\x5b\x5d-\x7e]*$/;
// Decoded layers that must never start a path: "//host" and "/\host" are both protocol-relative URLs.
const ABSOLUTE_START = /^\/[/\\]/;
const PROBE_ORIGIN = 'http://hvwa.invalid';
// The sign-in pages themselves: a next pointing back at them would loop or sign out again.
const SELF = /^\/(?:login|logout)(?:[/?#]|$)/i;

/**
 * A safe redirect target from untrusted input: a single leading '/', no '//' or backslash at the start,
 * no scheme, no control or non-ASCII characters, at most MAX_NEXT_LENGTH long; the same checks hold for
 * every percent-decoding of it (so '/%2F%2Fevil' and '/%252F%252Fevil' are refused too). The result is
 * the URL parser's normalised path + query + hash. Everything else, including /login and /logout,
 * falls back to '/'.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return '/';
  if (!PRINTABLE.test(raw) || !raw.startsWith('/') || ABSOLUTE_START.test(raw)) return '/';
  // Peel percent-encoding layer by layer (bounded): no layer may turn into an absolute or odd URL.
  let layer = raw;
  for (let i = 0; i < 4 && layer.includes('%'); i++) {
    let decoded: string;
    try { decoded = decodeURIComponent(layer); } catch { return '/'; }
    if (decoded === layer) break;
    // A decoded CR/LF, control character or backslash is refused (header injection, "/\host"); an encoded
    // space or letter is fine: the browser is sent the RAW, still-encoded path below, never a decoding.
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || ABSOLUTE_START.test(decoded) || !decoded.startsWith('/')) return '/';
    layer = decoded;
  }
  if (layer.includes('%') && /%(?:2f|5c)/i.test(layer)) return '/'; // still encoded after 4 layers: refuse
  let url: URL;
  try { url = new URL(raw, PROBE_ORIGIN); } catch { return '/'; }
  if (url.origin !== PROBE_ORIGIN) return '/';
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (!out.startsWith('/') || ABSOLUTE_START.test(out) || SELF.test(out)) return '/';
  return out;
}
