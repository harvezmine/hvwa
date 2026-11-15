// src/core/checker.ts — the engine's JSON API (/api/submit, /api/hint) and the
// pure functions the portal reuses. /api is JSON-only; HTML lives in the portal.
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getChallenge } from './registry.js';
import { recordSolve, bestSolve } from './scoreboard.js';
import { FLAG_LEVELS, pointsForLevel, type Level } from './levels.js';
import { unlockHint, parseTier } from './hints.js';

// Highest rank first; Divine is the secure reference and is never scored.
const SCORED_LEVELS_DESC = Object.freeze([...FLAG_LEVELS].reverse());

export type SubmitResult =
  | { status: 'unknown_challenge' }
  | { status: 'wrong' }
  | {
      /** new_best: the stored best improved; same_or_lower: it did not (see `best`). */
      status: 'new_best' | 'same_or_lower';
      /** The level this submission proved and its points. */
      level: Level;
      points: number;
      /** Points added to the stored best (0 unless new_best). */
      gained: number;
      /** The stored best after this submission. */
      best: { level: Level; points: number };
    };

/**
 * Check a submission. The client sends only { challengeId, submission }; the
 * server decides which level (if any) it proves, so points cannot be inflated
 * by a client-chosen level. A throwing check() propagates to the caller.
 */
export async function submitFlag(
  db: DatabaseSync, sid: string, challengeId: string, submission: string,
): Promise<SubmitResult> {
  const ch = getChallenge(challengeId);
  if (!ch) return { status: 'unknown_challenge' };
  for (const level of SCORED_LEVELS_DESC) {
    if (!ch.levels.includes(level)) continue;
    // check() never sees the platform DB.
    if (await ch.check({ sessionId: sid, level, submission })) {
      const points = pointsForLevel(ch.points, level);
      const prev = bestSolve(db, sid, ch.id);
      recordSolve(db, sid, ch.id, level, points);
      const best = bestSolve(db, sid, ch.id) ?? { level, points };
      const improved = prev === undefined || points > prev.points;
      return {
        status: improved ? 'new_best' : 'same_or_lower',
        level, points, gained: improved ? points - (prev?.points ?? 0) : 0, best,
      };
    }
  }
  return { status: 'wrong' };
}

export function checkerRouter(db: DatabaseSync): Router {
  const r = Router();

  r.post('/submit', async (req, res) => {
    const { challengeId, submission } = req.body ?? {};
    const result = await submitFlag(
      db, req.sessionId, String(challengeId ?? ''), typeof submission === 'string' ? submission : '',
    );
    if (result.status === 'unknown_challenge') {
      res.status(404).json({ solved: false, error: 'unknown_challenge' });
    } else if (result.status === 'wrong') {
      res.json({ solved: false });
    } else {
      // level/points = what this submission proved; best = the stored row
      // (unchanged when a lower level is re-solved after a higher one).
      res.json({ solved: true, level: result.level, points: result.points, best: result.best });
    }
  });

  r.post('/hint', (req, res) => {
    const { challengeId, tier: rawTier } = req.body ?? {};
    const cid = String(challengeId ?? '');
    if (!getChallenge(cid)) {
      res.status(404).json({ unlocked: false, error: 'unknown_challenge' });
      return;
    }
    const tier = parseTier(rawTier);
    if (tier === undefined) {
      res.status(400).json({ unlocked: false, error: 'invalid_tier' });
      return;
    }
    const result = unlockHint(db, req.sessionId, cid, tier);
    if (!result.ok) {
      res.status(404).json({ unlocked: false, error: result.error });
      return;
    }
    const { hint } = result;
    res.json({ unlocked: true, tier: hint.id, text: hint.text, cost: hint.cost });
  });

  return r;
}
