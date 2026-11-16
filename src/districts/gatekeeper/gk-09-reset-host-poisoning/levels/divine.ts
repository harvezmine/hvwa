import { CANONICAL_ORIGIN, type HeaderOf } from '../model.js';

// DIVINE — secure reference: the citadel's absolute links come only from its configured canonical base URL.
// No request header (Host, X-Forwarded-Host, Forwarded, X-Forwarded-Proto ...) has any say in where a reset
// link or a redirect points, so nobody can make the admin's reset mail link to their own server.
// Out of scope here: behind a real proxy, accept forwarded headers only from that proxy's address, and rate-limit
// reset requests per account.
export function linkOrigin(_headerOf: HeaderOf): string {
  return CANONICAL_ORIGIN;
}
