import { createHash } from 'node:crypto';
import type { Exchange, IssuedCode } from '../model.js';

const REGISTERED = 'http://citadel.test/callback';
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

// DIVINE — secure reference. Pilgrim-ID sends a code only to the EXACT registered redirect_uri, and only for a
// request carrying a PKCE (S256) challenge. A code is redeemed once, by the client it was issued to, for the
// redirect_uri it was sent to, and only with the verifier whose hash is that challenge (Citadel keeps the verifier on
// the server, so a code that leaks is useless). Citadel's callback forwards nowhere, and its page sends no Referer.
// Errors are generic. Out of scope here: signed ID tokens, consent screens, and token revocation.
export function allowRedirect(redirectUri: string): boolean {
  return redirectUri === REGISTERED;
}

export function checkPkce(challenge: string | undefined, method: string | undefined): string | undefined {
  return challenge !== undefined && challenge !== '' && method === 'S256' ? undefined : 'PKCE (S256) is required.';
}

export function redeem(issued: IssuedCode | undefined, exchange: Exchange, nowMs: number): boolean {
  if (issued === undefined || issued.used) return false;
  issued.used = true; // single use, whatever happens next
  if (nowMs >= issued.expiresAt || issued.clientId !== exchange.clientId || issued.redirectUri !== exchange.redirectUri) return false;
  return issued.challenge !== undefined && exchange.verifier !== undefined && s256(exchange.verifier) === issued.challenge;
}

export const pkce = true;

export function landing(_next: string | undefined): { forward?: string; referrerPolicy?: string } {
  return { referrerPolicy: 'no-referrer' };
}
