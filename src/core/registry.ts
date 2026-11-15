// src/core/registry.ts
import { verifyFlag } from './flags.js';
import type { Level } from './levels.js';

export type { Level } from './levels.js';

export interface HintTier { id: 1 | 2 | 3; text: { id: string; en: string }; cost: number; }

export interface Challenge {
  id: string;                 // e.g. "GK-01"
  district: string;           // e.g. "gatekeeper"
  slug: string;               // url segment, e.g. "sqli-login"
  title: { id: string; en: string };
  summary: { id: string; en: string };
  maps: string[];             // ["A05:2025","CWE-89"]
  levels: Level[];            // which levels are implemented
  points: number;             // base points (scaled by top level solved)
  hints: HintTier[];
  /**
   * Decide whether `ctx.submission` proves a solve AT `ctx.level`.
   *
   * Contract (POST /api/submit relies on it):
   * - The checker calls check() once per implemented non-Divine level,
   *   highest rank first (inquisitor → templar → acolyte), and credits the
   *   first level for which it returns true. The client never picks the level.
   * - Return true ONLY for the level the submission actually proves. Returning
   *   true regardless of `ctx.level` would credit the highest implemented level
   *   for any valid answer and inflate the score.
   * - Must be side-effect free (no writes, no counters, no event logging): it
   *   may be called up to 3 times for a single submit. The checker records
   *   the solve itself.
   * - Has NO access to the platform DB. A custom check that needs challenge
   *   data reads the challenge's own DB (from challengeDb()) via closure,
   *   read-only.
   * - Throwing yields a 500 `{ error: 'internal_error' }` with no details.
   *
   * Defaults to verifyFlag(id, ctx.sessionId, ctx.level, ctx.submission).
   */
  check: (ctx: CheckContext) => Promise<boolean> | boolean;
  mount: (router: import('express').Router) => void; // attaches vulnerable routes
}

/**
 * Input to Challenge.check(). `level` is chosen by the server (never the
 * client) and is never 'divine'; check() may be invoked once per candidate
 * level for the same submission.
 */
export interface CheckContext {
  sessionId: string;
  level: Level;
  submission: string;         // flag or answer the player submits
}

// `points` defaults to 100; `check` defaults to verifying the level-bound flag.
export function defineChallenge(
  input: Omit<Challenge, 'points' | 'check'> & { points?: number; check?: Challenge['check'] },
): Challenge {
  if (!/^[A-Z]{2}-\d{2}$/.test(input.id)) throw new Error(`bad challenge id ${input.id}`);
  if (input.levels.length === 0) throw new Error(`${input.id} has no levels`);
  const { points = 100, check, ...rest } = input;
  return {
    ...rest,
    points,
    check: check ?? ((ctx) => verifyFlag(input.id, ctx.sessionId, ctx.level, ctx.submission)),
  };
}

const _all = new Map<string, Challenge>();
export function register(c: Challenge): void {
  if (_all.has(c.id)) throw new Error(`duplicate challenge ${c.id}`);
  _all.set(c.id, c);
}
export function allChallenges(): Challenge[] { return [..._all.values()]; }
export function getChallenge(id: string): Challenge | undefined { return _all.get(id); }
