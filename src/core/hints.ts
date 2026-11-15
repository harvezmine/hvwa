// src/core/hints.ts
import type { DatabaseSync } from 'node:sqlite';
import { getChallenge, type HintTier } from './registry.js';

// Unlock a hint tier for a session; returns the hint (or undefined if the
// challenge/tier does not exist). Idempotent — unlocking twice costs once.
export function unlockHint(db: DatabaseSync, sid: string, cid: string, tier: number): HintTier | undefined {
  const ch = getChallenge(cid);
  if (!ch) return undefined;
  const hint = ch.hints.find((h) => h.id === tier);
  if (!hint) return undefined;
  db.prepare('INSERT OR IGNORE INTO hint_unlocks (session_id,challenge_id,tier) VALUES (?,?,?)')
    .run(sid, cid, tier);
  return hint;
}

export function unlockedTiers(db: DatabaseSync, sid: string, cid: string): number[] {
  const rows = db
    .prepare('SELECT tier FROM hint_unlocks WHERE session_id=? AND challenge_id=? ORDER BY tier')
    .all(sid, cid) as { tier: number }[];
  return rows.map((r) => r.tier);
}

// Total hint cost spent by a session (deducted from the raw score).
export function hintCost(db: DatabaseSync, sid: string): number {
  const rows = db
    .prepare('SELECT challenge_id, tier FROM hint_unlocks WHERE session_id=?')
    .all(sid) as { challenge_id: string; tier: number }[];
  let total = 0;
  for (const r of rows) {
    const hint = getChallenge(r.challenge_id)?.hints.find((h) => h.id === r.tier);
    if (hint) total += hint.cost;
  }
  return total;
}
