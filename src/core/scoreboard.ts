// src/core/scoreboard.ts
import type { DatabaseSync } from 'node:sqlite';
export function recordSolve(db: DatabaseSync, sid: string, cid: string, level: string, pts: number): void {
  db.prepare(`INSERT OR IGNORE INTO solves (session_id,challenge_id,level,solved_at)
    VALUES (?,?,?,?)`).run(sid, cid, level, Date.now());
  // store points via a view-less sum table kept simple: recompute on read
}
export function scoreFor(db: DatabaseSync, sid: string): number {
  const rows = db.prepare('SELECT challenge_id FROM solves WHERE session_id=?').all(sid);
  return rows.length * 100; // base; Task 7 scales by level
}
export function progress(db: DatabaseSync, sid: string): { solved: number } {
  const r = db.prepare('SELECT COUNT(*) c FROM solves WHERE session_id=?').get(sid) as { c: number };
  return { solved: r.c };
}
