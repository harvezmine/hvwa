// src/core/checker.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getChallenge } from './registry.js';
import { recordSolve, bestSolve } from './scoreboard.js';
import { FLAG_LEVELS, pointsForLevel } from './levels.js';
import { unlockHint, parseTier } from './hints.js';

// Highest rank first; Divine is the secure reference and is never scored.
const SCORED_LEVELS_DESC = Object.freeze([...FLAG_LEVELS].reverse());

// Mounts the solve-check + hint endpoints. The client sends only
// { challengeId, submission }; the server decides which level (if any) the
// submission proves, so points cannot be inflated by a client-chosen level.
export function checkerRouter(db: DatabaseSync): Router {
  const r = Router();

  r.post('/submit', async (req, res) => {
    const sid = req.sessionId;
    const { challengeId, submission } = req.body ?? {};
    const ch = getChallenge(String(challengeId ?? ''));
    if (!ch) {
      res.status(404).json({ solved: false, error: 'unknown_challenge' });
      return;
    }
    const answer = typeof submission === 'string' ? submission : '';
    for (const level of SCORED_LEVELS_DESC) {
      if (!ch.levels.includes(level)) continue;
      // A throwing check() propagates to the app error handler (500, no stack).
      // check() never sees the platform DB.
      if (await ch.check({ sessionId: sid, level, submission: answer })) {
        const points = pointsForLevel(ch.points, level);
        recordSolve(db, sid, ch.id, level, points);
        // level/points = what this submission proved; best = the stored row
        // (unchanged when a lower level is re-solved after a higher one).
        const best = bestSolve(db, sid, ch.id) ?? { level, points };
        res.json({ solved: true, level, points, best });
        return;
      }
    }
    res.json({ solved: false });
  });

  r.post('/hint', (req, res) => {
    const sid = req.sessionId;
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
    const result = unlockHint(db, sid, cid, tier);
    if (!result.ok) {
      res.status(404).json({ unlocked: false, error: result.error });
      return;
    }
    const { hint } = result;
    res.json({ unlocked: true, tier: hint.id, text: hint.text, cost: hint.cost });
  });

  return r;
}
