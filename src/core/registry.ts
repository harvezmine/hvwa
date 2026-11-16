// src/core/registry.ts — the declarative challenge registry.
import type { Request, Router } from 'express';
import { isAbsolute } from 'node:path';
import { verifyFlag } from './flags.js';
import { isLevel, type Level } from './levels.js';
import { assertVictimConfig, type VictimConfig } from './victim.js';

export type { Level } from './levels.js';

/** Bilingual text; challenge copy lives here, not in the platform dictionary. */
export interface Text { readonly id: string; readonly en: string }

export interface HintTier {
  readonly id: 1 | 2 | 3;
  readonly text: Text;
  /** Points deducted when unlocked (integer >= 0), stored at unlock time. */
  readonly cost: number;
}

export interface Challenge {
  readonly id: string;               // "GK-01": two capitals, dash, two digits
  readonly district: string;         // "gatekeeper" (kebab-case a-z0-9)
  readonly slug: string;             // "sqli-login" (kebab-case a-z0-9); served at /d/<district>/<slug>
  /** Absolute path of the challenge folder; its levels/<level>.ts files back View Source and Diff. */
  readonly dir: string;
  readonly title: Text;
  readonly summary: Text;
  readonly maps: readonly string[];  // ["A05:2025", "CWE-89"]
  readonly levels: readonly Level[]; // implemented levels: unique, >= 1 non-Divine
  readonly points: number;           // positive integer base points (scaled per level)
  readonly hints: readonly HintTier[];
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
  readonly check: (ctx: CheckContext) => Promise<boolean> | boolean;
  /**
   * Attach the vulnerable routes to `router`, which the engine mounts at
   * /d/<district>/<slug>. Routes are RELATIVE (router.all('/', …)); req.level
   * is already clamped to `levels`, and res.locals.{level,challenge} are set.
   */
  readonly mount: (router: Router) => void;
  /**
   * Optional "Restart lab" hook for labs that keep state (counters, lockouts, sessions, codes).
   * When defined, the engine mounts POST <lab>/_reset, which calls it with the player's session id
   * and the served level, then redirects (303) back to the lab, and the lab bar shows a
   * "Restart lab" button. Typically `reset: (req) => labs.reset(req)` on the lab's perSession holder.
   * The route enforces a per-(session, level) cooldown (`resetCooldownMs`, default 10 s; 429 while cooling).
   * NEVER offer a reset on a lab with a limiter, lockout or attempt budget: Restart would refill it.
   */
  readonly reset?: (req: Pick<Request, 'sessionId' | 'level'>) => void;
  /** Minimum ms between two resets of the same (session, level). Integer >= 0; default 10 000. */
  readonly resetCooldownMs?: number;
  /**
   * Optional simulated victim for labs where someone else must click (core/sim.ts, docs/RECIPES.md "Victim-driven
   * labs"). The engine mounts `POST <lab>/victim/<name>` for each action (runs it, 303 back to the lab) BEFORE the
   * lab's own routes, and shows the player's inbox and attacker log under every lab page.
   */
  readonly victim?: VictimConfig;
}

/**
 * Input to Challenge.check(). `level` is chosen by the server (never the
 * client) and is never 'divine'; check() may be invoked once per candidate
 * level for the same submission.
 */
export interface CheckContext {
  readonly sessionId: string;
  readonly level: Level;
  readonly submission: string;       // flag or answer the player submits
}

/** defineChallenge() input: `points` defaults to 100, `check` to the flag verifier. */
export type ChallengeInput =
  Omit<Challenge, 'points' | 'check'> & { points?: number; check?: Challenge['check'] };

const ID_RE = /^[A-Z]{2}-\d{2}$/;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validate(c: Challenge): void {
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) throw new Error(`bad challenge id ${String(c.id)}`);
  const at = `challenge ${c.id}`;
  if (typeof c.district !== 'string' || !KEBAB_RE.test(c.district)) {
    throw new Error(`${at}: bad district "${String(c.district)}" (kebab-case a-z0-9)`);
  }
  if (typeof c.slug !== 'string' || !KEBAB_RE.test(c.slug)) {
    throw new Error(`${at}: bad slug "${String(c.slug)}" (kebab-case a-z0-9)`);
  }
  if (typeof c.dir !== 'string' || !isAbsolute(c.dir)) {
    throw new Error(`${at}: dir must be an absolute path (got ${String(c.dir)})`);
  }
  if (!Array.isArray(c.levels) || c.levels.length === 0) throw new Error(`${c.id} has no levels`);
  for (const l of c.levels) if (!isLevel(l)) throw new Error(`${at}: unknown level "${String(l)}"`);
  if (new Set(c.levels).size !== c.levels.length) throw new Error(`${at}: duplicate level`);
  if (!c.levels.some((l) => l !== 'divine')) throw new Error(`${at}: needs at least one non-Divine level`);
  if (!Number.isInteger(c.points) || c.points <= 0) {
    throw new Error(`${at}: points must be a positive integer (got ${String(c.points)})`);
  }
  const hintIds = new Set<number>();
  for (const h of c.hints) {
    if (h.id !== 1 && h.id !== 2 && h.id !== 3) throw new Error(`${at}: hint id must be 1, 2 or 3 (got ${String(h.id)})`);
    if (hintIds.has(h.id)) throw new Error(`${at}: duplicate hint id ${h.id}`);
    hintIds.add(h.id);
    if (!Number.isInteger(h.cost) || h.cost < 0) {
      throw new Error(`${at}: hint ${h.id} cost must be an integer >= 0 (got ${String(h.cost)})`);
    }
  }
  if (typeof c.check !== 'function') throw new Error(`${at}: check must be a function`);
  if (typeof c.mount !== 'function') throw new Error(`${at}: mount must be a function`);
  if (c.reset !== undefined && typeof c.reset !== 'function') throw new Error(`${at}: reset must be a function`);
  if (c.resetCooldownMs !== undefined && (!Number.isInteger(c.resetCooldownMs) || c.resetCooldownMs < 0)) {
    throw new Error(`${at}: resetCooldownMs must be an integer >= 0 (got ${String(c.resetCooldownMs)})`);
  }
  if (c.victim !== undefined) assertVictimConfig(c.victim, at);
}

/** Validate challenge metadata and fill defaults. Throws on any invalid field. */
export function defineChallenge(input: ChallengeInput): Challenge {
  const { points = 100, check, ...rest } = input;
  const c: Challenge = {
    ...rest,
    points,
    check: check ?? ((ctx) => verifyFlag(input.id, ctx.sessionId, ctx.level, ctx.submission)),
  };
  validate(c);
  return c;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const byId = new Map<string, Challenge>();
const byRoute = new Map<string, string>(); // "district/slug" → id

/**
 * Add a challenge to the registry (re-validated), deep-freeze it, and return
 * it. Rejects a repeated id or a repeated district/slug. Registration happens
 * at import time; createApp() mounts whatever is registered when it runs.
 */
export function register(c: Challenge): Challenge {
  validate(c);
  if (byId.has(c.id)) throw new Error(`duplicate challenge ${c.id}`);
  const route = `${c.district}/${c.slug}`;
  const owner = byRoute.get(route);
  if (owner) throw new Error(`duplicate route /d/${route} (${c.id} vs ${owner})`);
  deepFreeze(c);
  byId.set(c.id, c);
  byRoute.set(route, c.id);
  return c;
}

export function allChallenges(): Challenge[] { return [...byId.values()]; }
export function getChallenge(id: string): Challenge | undefined { return byId.get(id); }
