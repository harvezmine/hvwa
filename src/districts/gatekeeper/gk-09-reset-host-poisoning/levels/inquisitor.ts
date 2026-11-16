import { CANONICAL_ORIGIN, type HeaderOf } from '../model.js';

/** The host= parameter of the first element of an RFC 7239 Forwarded header ("for=..;host=..;proto=.., ..."). */
function forwardedHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split(',')[0];
  for (const pair of first.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim().toLowerCase() !== 'host') continue;
    const host = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    return host === '' ? undefined : host;
  }
  return undefined;
}

// INQUISITOR — X-Forwarded-Host is finally ignored ("anyone can send that"). But the app now reads the
// standardized RFC 7239 Forwarded header instead, and trusts its host= just as blindly. A standard name does not
// make a client-written header trustworthy: only the proxy's own address could vouch for it.
export function linkOrigin(headerOf: HeaderOf): string {
  const host = forwardedHost(headerOf('forwarded'));
  return host !== undefined ? `http://${host}` : CANONICAL_ORIGIN;
}
