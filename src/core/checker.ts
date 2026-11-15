// src/core/checker.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getChallenge } from './registry.js';
import { recordSolve } from './scoreboard.js';
import { resolveLevel, pointsForLevel } from './difficulty.js';
import { unlockHint } from './hints.js';

// Mounts the solve-check + hint endpoints. The challenge's own check()
// decides whether a submission is a solve; on success we record it.
export function checkerRouter(db: DatabaseSync): Router {
  const r = Router();

  r.post('/submit', async (req, res) => {
    const sid = (req as any).sessionId as string;
    const { challengeId, level: rawLevel, submission } = req.body ?? {};
    const ch = getChallenge(String(challengeId ?? ''));
    if (!ch) {
      res.status(404).json({ solved: false, error: 'unknown challenge' });
      return;
    }
    const level = resolveLevel(rawLevel);
    const solved = await ch.check({
      sessionId: sid,
      level,
      submission: String(submission ?? ''),
      db,
    });
    if (solved) {
      recordSolve(db, sid, ch.id, level, pointsForLevel(ch.points, level));
    }
    res.json({ solved: Boolean(solved) });
  });

  r.post('/hint', (req, res) => {
    const sid = (req as any).sessionId as string;
    const { challengeId, tier } = req.body ?? {};
    const hint = unlockHint(db, sid, String(challengeId ?? ''), Number(tier));
    if (!hint) {
      res.status(404).json({ unlocked: false, error: 'unknown challenge or tier' });
      return;
    }
    res.json({ unlocked: true, tier: hint.id, text: hint.text, cost: hint.cost });
  });

  return r;
}
