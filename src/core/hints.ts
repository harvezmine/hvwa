// src/core/hints.ts
import type { DatabaseSync } from 'node:sqlite';
import { getChallenge, type HintTier } from './registry.js';

/** A hint tier from client input: integer 1..3 (number or numeric string), else undefined. */
export function parseTier(raw: unknown): HintTier['id'] | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n === 1 || n === 2 || n === 3 ? n : undefined;
}

export type UnlockResult =
  | { ok: true; hint: HintTier }
  | { ok: false; error: 'unknown_challenge' | 'unknown_tier' };

// Unlock a hint tier for a session. The cost is stored with the unlock, so a
// later change to (or removal of) the challenge never rewrites past scores.
// Idempotent: unlocking twice records (and costs) once.
export function unlockHint(db: DatabaseSync, sid: string, cid: string, tier: HintTier['id']): UnlockResult {
  const ch = getChallenge(cid);
  if (!ch) return { ok: false, error: 'unknown_challenge' };
  const hint = ch.hints.find((h) => h.id === tier);
  if (!hint) return { ok: false, error: 'unknown_tier' };
  db.prepare('INSERT OR IGNORE INTO hint_unlocks (session_id,challenge_id,tier,cost) VALUES (?,?,?,?)')
    .run(sid, cid, tier, hint.cost);
  return { ok: true, hint };
}

export function unlockedTiers(db: DatabaseSync, sid: string, cid: string): number[] {
  const rows = db
    .prepare('SELECT tier FROM hint_unlocks WHERE session_id=? AND challenge_id=? ORDER BY tier')
    .all(sid, cid) as { tier: number }[];
  return rows.map((r) => r.tier);
}

// Total hint cost spent by a session (deducted from the raw score), from the
// costs stored at unlock time.
export function hintCost(db: DatabaseSync, sid: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost),0) AS total FROM hint_unlocks WHERE session_id=?')
    .get(sid) as { total: number };
  return Number(r.total);
}
