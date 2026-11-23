// src/range/progress.ts — range scoring, keyed by users.id (spec range §4): one row per (user, lab) holding the best
// level, hint unlocks with their cost captured at unlock time, a score floored at 0, and the leaderboard.
import type { DatabaseSync } from 'node:sqlite';
import { isLevel, type Level } from '../core/levels.js';
import type { LabEntry } from '../lab-registry.js';

export interface Best { readonly level: Level; readonly points: number }
export type SolveResult =
  | { readonly status: 'new_best'; readonly best: Best; readonly gained: number }
  | { readonly status: 'same_or_lower'; readonly best: Best; readonly gained: 0 };

export function bestRangeSolve(db: DatabaseSync, userId: number, labId: string): Best | undefined {
  const r = db.prepare('SELECT level, points FROM range_solves WHERE user_id = ? AND lab_id = ?').get(userId, labId) as
    { level: string; points: number } | undefined;
  return r && isLevel(r.level) ? { level: r.level, points: Number(r.points) } : undefined;
}

/** Record a proved level: the stored best changes only when this one is worth more. */
export function recordRangeSolve(db: DatabaseSync, userId: number, labId: string, level: Level, points: number, at: number): SolveResult {
  const prev = bestRangeSolve(db, userId, labId);
  db.prepare(`INSERT INTO range_solves (user_id, lab_id, level, points, solved_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, lab_id) DO UPDATE SET level = excluded.level, points = excluded.points, solved_at = excluded.solved_at
    WHERE excluded.points > range_solves.points`).run(userId, labId, level, points, at);
  const best = bestRangeSolve(db, userId, labId) ?? { level, points };
  if (prev === undefined || points > prev.points) return { status: 'new_best', best, gained: points - (prev?.points ?? 0) };
  return { status: 'same_or_lower', best, gained: 0 };
}

/** Every best solve of a user, by lab id. */
export function rangeSolvesOf(db: DatabaseSync, userId: number): Map<string, Best> {
  const rows = db.prepare('SELECT lab_id, level, points FROM range_solves WHERE user_id = ?').all(userId) as
    { lab_id: string; level: string; points: number }[];
  const out = new Map<string, Best>();
  for (const r of rows) if (isLevel(r.level)) out.set(r.lab_id, { level: r.level, points: Number(r.points) });
  return out;
}

export type HintUnlock = { ok: true; hint: LabEntry['hints'][number] } | { ok: false; error: 'unknown_tier' };

/** Unlock a paid hint (idempotent: twice costs once). The cost is stored with the unlock. */
export function unlockRangeHint(db: DatabaseSync, userId: number, lab: LabEntry, tier: number, at: number): HintUnlock {
  const hint = lab.hints.find((h) => h.id === tier);
  if (!hint) return { ok: false, error: 'unknown_tier' };
  db.prepare('INSERT OR IGNORE INTO range_hint_unlocks (user_id, lab_id, tier, cost, unlocked_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, lab.id, hint.id, hint.cost, at);
  return { ok: true, hint };
}

export function rangeUnlockedTiers(db: DatabaseSync, userId: number, labId: string): number[] {
  return (db.prepare('SELECT tier FROM range_hint_unlocks WHERE user_id = ? AND lab_id = ? ORDER BY tier').all(userId, labId) as
    { tier: number }[]).map((r) => Number(r.tier));
}

export function rangeHintCost(db: DatabaseSync, userId: number): number {
  return Number((db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM range_hint_unlocks WHERE user_id = ?').get(userId) as { c: number }).c);
}

/** Gold spent at the merchant on magic scrolls (src/range/shop.ts), used or still in the bag. */
export function rangeScrollCost(db: DatabaseSync, userId: number): number {
  return Number((db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM range_scrolls WHERE user_id = ?').get(userId) as { c: number }).c);
}

/** Sum of best-level points minus hint costs and scrolls bought, floored at 0. */
export function rangeScore(db: DatabaseSync, userId: number): number {
  const pts = Number((db.prepare('SELECT COALESCE(SUM(points), 0) AS p FROM range_solves WHERE user_id = ?').get(userId) as { p: number }).p);
  return Math.max(0, pts - rangeHintCost(db, userId) - rangeScrollCost(db, userId));
}

export interface LeaderRow {
  readonly rank: number;
  readonly userId: number;
  readonly username: string;
  readonly score: number;
  readonly solved: number;
  readonly lastSolveAt: number;
}

/** Spec §10: top players by score, then by the time of their last solve (earlier first); disabled accounts left out. */
export function leaderboard(db: DatabaseSync, limit = 100): LeaderRow[] {
  const rows = db.prepare(`
    WITH s AS (SELECT user_id, SUM(points) AS pts, COUNT(*) AS solved, MAX(solved_at) AS last_at FROM range_solves GROUP BY user_id),
         h AS (SELECT user_id, SUM(cost) AS cost FROM range_hint_unlocks GROUP BY user_id),
         g AS (SELECT user_id, SUM(cost) AS cost FROM range_scrolls GROUP BY user_id)
    SELECT u.id AS id, u.username AS username, MAX(0, s.pts - COALESCE(h.cost, 0) - COALESCE(g.cost, 0)) AS score, s.solved AS solved, s.last_at AS last_at
    FROM users u JOIN s ON s.user_id = u.id LEFT JOIN h ON h.user_id = u.id LEFT JOIN g ON g.user_id = u.id
    WHERE u.disabled = 0
    ORDER BY score DESC, last_at ASC, username ASC
    LIMIT ?`).all(limit) as { id: number; username: string; score: number; solved: number; last_at: number }[];
  return rows.map((r, i) => ({
    rank: i + 1, userId: Number(r.id), username: r.username, score: Number(r.score), solved: Number(r.solved), lastSolveAt: Number(r.last_at),
  }));
}
