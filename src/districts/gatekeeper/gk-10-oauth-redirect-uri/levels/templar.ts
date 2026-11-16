import type { Exchange, IssuedCode } from '../model.js';

// TEMPLAR — a naive allow-check: the redirect_uri must START WITH http://citadel.test. A prefix of a URL is not its
// origin: http://citadel.test.<your-domain>/... (a host of your own) and http://citadel.test@<your-host>/ (userinfo)
// both start that way, and the code goes there. The token endpoint is as loose as before.
export function allowRedirect(redirectUri: string): boolean {
  return redirectUri.startsWith('http://citadel.test');
}

export function checkPkce(_challenge: string | undefined, _method: string | undefined): string | undefined {
  return undefined;
}

export function redeem(issued: IssuedCode | undefined, exchange: Exchange, nowMs: number): boolean {
  return issued !== undefined && nowMs < issued.expiresAt && issued.clientId === exchange.clientId;
}

export const pkce = false;

export function landing(_next: string | undefined): { forward?: string; referrerPolicy?: string } {
  return {};
}
