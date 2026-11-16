import { CANONICAL_ORIGIN, type HeaderOf } from '../model.js';

// ACOLYTE — "we sit behind a proxy, so trust what it says our name is": the host of every absolute link is
// X-Forwarded-Host, verbatim. But that header is written by whoever sends the request. Ask for the admin's reset
// with your own server's name in it, and the admin's reset mail links there.
export function linkOrigin(headerOf: HeaderOf): string {
  const forwarded = headerOf('x-forwarded-host');
  return forwarded ? `http://${forwarded}` : CANONICAL_ORIGIN;
}
