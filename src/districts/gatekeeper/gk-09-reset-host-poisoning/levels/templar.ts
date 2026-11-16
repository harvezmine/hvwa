import { CANONICAL_ORIGIN, type HeaderOf } from '../model.js';

// TEMPLAR — a naive allow-check: X-Forwarded-Host is used only if it "looks like ours", i.e. it CONTAINS the word
// citadel somewhere. A substring is not a host name: anyone can own a name with that word in it (a subdomain of
// their own server, or a path after their host), and the mail links there.
export function linkOrigin(headerOf: HeaderOf): string {
  const forwarded = headerOf('x-forwarded-host');
  return forwarded !== undefined && forwarded.includes('citadel') ? `http://${forwarded}` : CANONICAL_ORIGIN;
}
