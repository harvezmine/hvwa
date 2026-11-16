import type { Exchange, IssuedCode } from '../model.js';

// ACOLYTE — Pilgrim-ID sends the authorization code to ANY redirect_uri the request names. Nothing ties the code to the
// client's registered callback, so an authorize link with your own server as redirect_uri, opened by a signed-in admin,
// hands you the admin's code. The token endpoint then takes any live code for the client, as often as it is presented
// (not single-use, not bound to where it was sent), so Citadel's real callback signs you in as the admin.
export function allowRedirect(_redirectUri: string): boolean {
  return true;
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
