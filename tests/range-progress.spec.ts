// Range scoring keyed by users.id (src/range/progress.ts, spec range §4): best level per lab, paid hints with the cost
// captured at unlock time, a score floored at 0, and a leaderboard ranked by score, then by the earlier last solve.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService } from '../src/auth/service.js';
import {
  bestRangeSolve, leaderboard, rangeHintCost, rangeScore, rangeSolvesOf, STARTER_PURSE, rangeUnlockedTiers, recordRangeSolve, unlockRangeHint,
} from '../src/range/progress.js';
import { FAST_HASHER } from './helpers.js';
import { testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
async function setup(...names: string[]) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  const service = createAuthService(db, { hasher: FAST_HASHER, initialPassword: 'Admin-Pass-1234', passwordMinLength: 10 });
  const ids: number[] = [];
  for (const n of names) {
    const r = await service.register(n, 'Player-Pass-1', 'Player-Pass-1');
    if (!r.ok) throw new Error(r.error);
    ids.push(r.userId);
  }
  return { db, service, ids };
}
const clinic = testRegistry().get('r01')!;

describe('recordRangeSolve', () => {
  it('keeps the best level per (user, lab): a higher one replaces it, a lower one does not', async () => {
    const { db, ids: [alice] } = await setup('alice');
    expect(recordRangeSolve(db, alice, 'r01', 'templar', 150, 10)).toEqual({ status: 'new_best', best: { level: 'templar', points: 150 }, gained: 150 });
    expect(recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 20)).toEqual({ status: 'same_or_lower', best: { level: 'templar', points: 150 }, gained: 0 });
    expect(recordRangeSolve(db, alice, 'r01', 'inquisitor', 200, 30)).toEqual({ status: 'new_best', best: { level: 'inquisitor', points: 200 }, gained: 50 });
    expect(bestRangeSolve(db, alice, 'r01')).toEqual({ level: 'inquisitor', points: 200 });
    expect([...rangeSolvesOf(db, alice)]).toEqual([['r01', { level: 'inquisitor', points: 200 }]]);
  });

  it('a same-level repeat keeps the first time it was reached (the leaderboard tie-break)', async () => {
    const { db, ids: [alice] } = await setup('alice');
    recordRangeSolve(db, alice, 'r01', 'templar', 150, 10);
    expect(recordRangeSolve(db, alice, 'r01', 'templar', 150, 99)).toMatchObject({ status: 'same_or_lower', gained: 0 });
    expect(db.prepare('SELECT solved_at FROM range_solves').get()).toEqual({ solved_at: 10 });
  });

  it('is per user: another user\'s solve is not mine', async () => {
    const { db, ids: [alice, bob] } = await setup('alice', 'bob');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 10);
    expect(rangeSolvesOf(db, bob).size).toBe(0);
    expect(rangeScore(db, bob)).toBe(STARTER_PURSE); // only the starter purse every account holds
  });
});

describe('hints', () => {
  it('unlocking costs the hint\'s cost once; unknown tiers are refused; the score is floored at 0', async () => {
    const { db, ids: [alice] } = await setup('alice');
    expect(unlockRangeHint(db, alice, clinic, 2, 5)).toEqual({ ok: false, error: 'unknown_tier' });
    expect(unlockRangeHint(db, alice, clinic, 1, 5)).toMatchObject({ ok: true, hint: { id: 1, cost: 10 } });
    expect(unlockRangeHint(db, alice, clinic, 1, 6)).toMatchObject({ ok: true });
    expect(rangeUnlockedTiers(db, alice, 'r01')).toEqual([1]);
    expect(rangeHintCost(db, alice)).toBe(10);
    expect(rangeScore(db, alice)).toBe(STARTER_PURSE - 10);
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 10);
    expect(rangeScore(db, alice)).toBe(STARTER_PURSE + 90);
    db.prepare('INSERT INTO range_hint_unlocks (user_id, lab_id, tier, cost, unlocked_at) VALUES (?, ?, 9, 500, 11)').run(alice, 'r01');
    expect(rangeScore(db, alice)).toBe(0); // floored
  });
});

describe('leaderboard', () => {
  it('ranks by score, then by the earlier last solve, then by name; only users with a solve; disabled users are left out', async () => {
    const { db, ids: [alice, bob, carol, dave] } = await setup('alice', 'bob', 'carol', 'dave');
    recordRangeSolve(db, alice, 'r01', 'templar', 150, 300);
    recordRangeSolve(db, bob, 'r01', 'templar', 150, 200);   // same score, earlier: ahead of alice
    recordRangeSolve(db, carol, 'r01', 'inquisitor', 200, 900);
    recordRangeSolve(db, carol, 'r02', 'acolyte', 200, 950);
    recordRangeSolve(db, dave, 'r02', 'acolyte', 200, 100);
    unlockRangeHint(db, dave, clinic, 1, 101);               // 20 + 200 - 10 = 210
    expect(leaderboard(db)).toEqual([
      { rank: 1, userId: carol, username: 'carol', score: 420, solved: 2, lastSolveAt: 950 },
      { rank: 2, userId: dave, username: 'dave', score: 210, solved: 1, lastSolveAt: 100 },
      { rank: 3, userId: bob, username: 'bob', score: 170, solved: 1, lastSolveAt: 200 },
      { rank: 4, userId: alice, username: 'alice', score: 170, solved: 1, lastSolveAt: 300 },
    ]);
    // The compact POC has no admin operations (plan amendment, Task 3): the column is set directly.
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(carol);
    expect(leaderboard(db).map((r) => r.username)).toEqual(['dave', 'bob', 'alice']);
    expect(leaderboard(db, 2).map((r) => r.rank)).toEqual([1, 2]);
  });
});
