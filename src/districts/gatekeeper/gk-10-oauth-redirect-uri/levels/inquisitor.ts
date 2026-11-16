import type { Exchange, IssuedCode } from '../model.js';

const REGISTERED = 'http://citadel.test/callback';

// INQUISITOR — Pilgrim-ID now demands the EXACT registered redirect_uri, so the code always lands on Citadel's own
// callback. But that callback page has an open redirect: after signing in it moves the browser on to the `next` the
// sign-in started with (/login?next=...), as a page that forwards by itself, under the browser's default referrer
// policy. A page that moves on sends ITS OWN URL as the Referer, and the callback's URL still carries ?code=. Codes are
// still not single-use, so the code your server reads off the Referer signs you in as well.
export function allowRedirect(redirectUri: string): boolean {
  return redirectUri === REGISTERED;
}

export function checkPkce(_challenge: string | undefined, _method: string | undefined): string | undefined {
  return undefined;
}

export function redeem(issued: IssuedCode | undefined, exchange: Exchange, nowMs: number): boolean {
  return issued !== undefined && nowMs < issued.expiresAt && issued.clientId === exchange.clientId;
}

export const pkce = false;

export function landing(next: string | undefined): { forward?: string; referrerPolicy?: string } {
  return next !== undefined && next !== '' ? { forward: next } : {}; // anywhere, with the default Referrer-Policy
}
