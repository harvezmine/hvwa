// model.ts — GK-04's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { signHmac } from '../_shared/jwt.js';

import type { Claims, Verdict } from '../_shared/jwt-lab.js';
export { cookieName } from '../_shared/jwt-lab.js';
export type { Claims, Verdict };

/** One player's lab at one level. */
export interface LabState {
  /** The HS256 signing secret: random, and never the same in two sessions or two levels. */
  readonly secret: string;
  /** The clock (ms): a test seam for `iat`. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<JwtLevel> in challenge.ts). */
export interface JwtLevel {
  /** Decide whether `token` is acceptable. The verification policy is the whole lesson. */
  verify(state: LabState, token: string): Verdict;
}

// Per player AND per level: the signing secret belongs to one lab, so a token forged or minted in one
// lab is worthless in another.
const labs = perSession((): LabState => ({ secret: randomBytes(32).toString('hex'), now: Date.now }));

export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Sign claims the way the genuine server does (used for the sign-in and as a test seam). */
export function issueToken(state: LabState, claims: Claims): string {
  return signHmac('HS256', state.secret, { ...claims, iat: Math.floor(state.now() / 1000) });
}

/** Test seam: the lab state of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Test seam: a genuine token (signed by the real server key) for any claims. */
export function mintToken(sessionId: string, level: Level, claims: Claims): string {
  return issueToken(labState(sessionId, level), claims);
}
