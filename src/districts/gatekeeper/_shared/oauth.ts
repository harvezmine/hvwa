// _shared/oauth.ts — small plumbing the Pilgrim-ID labs (GK-10, GK-11) share: PKCE's verifier and S256, the code record
// and withParams (random ids and bounded maps live in districts/_shared/collections.ts). No policy lives here: which
// redirect_uri Pilgrim-ID accepts, which state Citadel honours, whether a code is single-use or bound to a verifier is
// each lab's level decision (levels/*.ts, where View Source and the Diff show it).
import { createHash, randomBytes } from 'node:crypto';

/** Citadel's client id at Pilgrim-ID. */
export const CLIENT_ID = 'citadel';

/** A fresh PKCE code_verifier (32 CSPRNG bytes, base64url). */
export const newVerifier = (): string => randomBytes(32).toString('base64url');
/** PKCE's S256: base64url(SHA-256(verifier)). */
export const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** An authorization code Pilgrim-ID issued. */
export interface IssuedCode {
  readonly user: string;
  readonly clientId: string;
  /** The redirect_uri it was sent to. */
  readonly redirectUri: string;
  /** The PKCE code_challenge (S256) the authorize request carried, if any. */
  readonly challenge?: string;
  readonly expiresAt: number;
  used: boolean;
}

/** What Citadel presents at Pilgrim-ID's token endpoint to redeem a code. */
export interface Exchange {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The PKCE code_verifier, when the sign-in used PKCE. */
  readonly verifier?: string;
}

/**
 * `uri` with `params` appended to its query, as an authorization server does: the uri is otherwise left as given, and a
 * fragment stays last (params after the `#` would be part of the fragment, which a browser never sends).
 */
export function withParams(uri: string, params: Readonly<Record<string, string>>): string {
  const hash = uri.indexOf('#');
  const before = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? '' : uri.slice(hash);
  return `${before}${before.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}${fragment}`;
}
