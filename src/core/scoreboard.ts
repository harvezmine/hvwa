// src/core/scoreboard.ts
import type { DatabaseSync } from 'node:sqlite';
import { hintCost } from './hints.js';
import { isLevel, type Level } from './levels.js';

// One row per (session, challenge), holding the best level solved so far.
// A later solve only replaces the row if it is worth more points.
export function recordSolve(db: DatabaseSync, sid: string, cid: string, level: string, pts: number): void {
  db.prepare(`INSERT INTO solves (session_id,challenge_id,level,points,solved_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(session_id,challenge_id) DO UPDATE SET
      level=excluded.level, points=excluded.points, solved_at=excluded.solved_at
    WHERE excluded.points > solves.points`).run(sid, cid, level, pts, Date.now());
}

// The stored (best) solve for one challenge, if any.
export function bestSolve(db: DatabaseSync, sid: string, cid: string): { level: Level; points: number } | undefined {
  const r = db.prepare('SELECT level, points FROM solves WHERE session_id=? AND challenge_id=?')
    .get(sid, cid) as { level: string; points: number } | undefined;
  return r && isLevel(r.level) ? { level: r.level, points: Number(r.points) } : undefined;
}

// `only` (an edition's ids, ChallengeSet.only) limits a score to those challenges: a data dir shared
// with the full edition may hold solves and hint costs of challenges this app does not serve.
const ONLY = 'challenge_id IN (SELECT value FROM json_each(?))';

// Sum of best-level points minus unlocked hint costs, floored at 0.
export function scoreFor(db: DatabaseSync, sid: string, only?: ReadonlySet<string>): number {
  const r = (only === undefined
    ? db.prepare('SELECT COALESCE(SUM(points),0) AS total FROM solves WHERE session_id=?').get(sid)
    : db.prepare(`SELECT COALESCE(SUM(points),0) AS total FROM solves WHERE session_id=? AND ${ONLY}`)
      .get(sid, JSON.stringify([...only]))) as { total: number };
  return Math.max(0, Number(r.total) - hintCost(db, sid, only));
}

export function progress(db: DatabaseSync, sid: string, only?: ReadonlySet<string>): { solved: number } {
  const r = (only === undefined
    ? db.prepare('SELECT COUNT(*) c FROM solves WHERE session_id=?').get(sid)
    : db.prepare(`SELECT COUNT(*) c FROM solves WHERE session_id=? AND ${ONLY}`).get(sid, JSON.stringify([...only]))) as { c: number };
  return { solved: r.c };
}
