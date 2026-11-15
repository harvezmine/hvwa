// model.ts — GK-05's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { generateRsaKeyPair, signRsa } from '../_shared/jwt.js';

import type { Claims, Verdict } from '../_shared/jwt-lab.js';
export { cookieName } from '../_shared/jwt-lab.js';
export type { Claims, Verdict };

/** One player's lab at one level: its own RSA key pair. */
export interface LabState {
  /** The PUBLIC key as PEM text; the lab publishes exactly this text at ./public.pem. */
  readonly publicPem: string;
  /** The private signing key. Never served. */
  readonly privatePem: string;
  /** The clock (ms): a test seam for `iat`. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<JwtLevel> in challenge.ts). */
export interface JwtLevel {
  /** Decide whether `token` is acceptable. Which algorithm and which key to trust is the whole lesson. */
  verify(state: LabState, token: string): Verdict;
}

// Per player AND per level, generated lazily on first use (2048-bit RSA takes a moment): a key that leaks
// or is abused in one lab means nothing in another.
const labs = perSession((): LabState => ({ ...generateRsaKeyPair(), now: Date.now }));

export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Sign claims the way the genuine server does: RS256 with the private key. */
export function issueToken(req: { sessionId: string; level: Level }, claims: Claims): string {
  const state = labFor(req);
  return signRsa('RS256', state.privatePem, { ...claims, iat: Math.floor(state.now() / 1000) });
}

/** Test seam: the lab state (both keys) of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Test seam: a genuine token (signed by the real server key) for any claims. */
export function mintToken(sessionId: string, level: Level, claims: Claims): string {
  return issueToken({ sessionId, level }, claims);
}
