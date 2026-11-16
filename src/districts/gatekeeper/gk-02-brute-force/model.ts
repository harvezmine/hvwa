// model.ts — GK-02's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomInt } from 'node:crypto';
import { fixtureLines } from '../../../core/fixtures.js';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { accountsFor, type Account, type Counter } from '../_shared/lab.js';

export type { Account, Counter };

/** What a login attempt came to. A failure carries the message the lab shows. */
export type LoginOutcome =
  | { ok: true; account: Account }
  | { ok: false; message: string };

/** One player's lab at one level. */
export interface LabState {
  /** The citadel admin's password: a random pick from the served wordlist. */
  readonly adminPassword: string;
  /** Lockout counters, keyed however the level keys them. */
  readonly counters: Map<string, Counter>;
  /** The clock (ms); a test seam so lockout expiry can be checked without waiting. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<BruteLevel> in challenge.ts). */
export interface BruteLevel {
  login(state: LabState, username: string, password: string): LoginOutcome;
}

/** Both accounts of this lab. */
export function accounts(state: LabState): readonly Account[] {
  return accountsFor(state.adminPassword);
}

/** The wordlist the lab serves at ./wordlist.txt (and the admin password is drawn from). */
export const wordlist = fixtureLines(new URL('./fixtures/wordlist.txt', import.meta.url));

// Per player AND per level: failures, lockouts and the admin password are all state a
// player changes or learns, so they must never cross players or levels.
const labs = perSession((): LabState => ({
  adminPassword: wordlist()[randomInt(wordlist().length)],
  counters: new Map(),
  now: Date.now,
}));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Test seam: the real citadel_admin password of session `sessionId` at `level`. */
export function adminPassword(sessionId: string, level: Level): string {
  return labState(sessionId, level).adminPassword;
}
