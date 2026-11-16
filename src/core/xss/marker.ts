// src/core/xss/marker.ts — the marker call a payload makes where a real one would call home: `hvwa('<nonce>')`. The
// nonce is per player and level (core/victim.ts newMarker(), made in the lab's perSession factory), so a payload proves
// one player's exploit at one level and nothing else.

/** The function a payload calls instead of stealing a cookie: the preview frame defines it; the oracle looks for it. */
export const MARKER_FUNCTION = 'hvwa';

const NONCE_RE = /^[0-9a-f]{8,32}$/;
const CALL_RE = /^hvwa\('([0-9a-f]{8,32})'\)$/;

/** The marker call for a nonce: `hvwa('<nonce>')`. Throws unless the nonce is 8 to 32 lower-case hex digits. */
export function markerCall(nonce: string): string {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new Error('markerCall: a nonce is 8 to 32 lower-case hex digits');
  return `${MARKER_FUNCTION}('${nonce}')`;
}

/** The nonce of a marker call made by markerCall(). Throws for anything else (a programming error in the lab). */
export function markerNonce(marker: string): string {
  const m = typeof marker === 'string' ? CALL_RE.exec(marker) : null;
  if (m === null) throw new Error("xss: the marker must be a marker call, hvwa('<nonce>') (markerCall / newMarker().call)");
  return m[1];
}

/**
 * A call of the marker, as JavaScript would make it: any quote style (' " `), spaces inside the parentheses, as a
 * plain or a method call (`window.hvwa('n')`), never `hvwax(...)`. The oracle does not parse JavaScript: a marker
 * call anywhere in a sink's code counts (one in a JS comment too), and obfuscation it cannot see does not.
 */
export function markerPattern(nonce: string): RegExp {
  if (!NONCE_RE.test(nonce)) throw new Error('markerPattern: bad nonce');
  return new RegExp(`(?<![\\w$])${MARKER_FUNCTION}\\s*\\(\\s*(['"\`])${nonce}\\1\\s*\\)`);
}
