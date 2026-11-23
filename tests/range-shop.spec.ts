// The merchant's scrolls and the Guildmaster's counsel (src/range/shop.ts): gold is spent when a scroll is bought, a
// scroll buys exactly one counsel of its own tier, a counsel already heard costs no second scroll, and the score and the
// leaderboard both count the scrolls.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService } from '../src/auth/service.js';
import { leaderboard, rangeScore, rangeUnlockedTiers, recordRangeSolve } from '../src/range/progress.js';
import { buyScroll, SCROLLS, scrollBag, scrollFor, seekCounsel } from '../src/range/shop.js';
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
  return { db, ids };
}
const clinic = testRegistry().get('r01')!;

describe('scrolls and counsel', () => {
  it('maps every counsel tier to a scroll kind, the last kind covering any deeper tier', () => {
    expect(SCROLLS.map((s) => s.tier)).toEqual([1, 2, 3]);
    expect(scrollFor(1)?.kind).toBe('insight');
    expect(scrollFor(3)?.kind).toBe('oracle');
    expect(scrollFor(5)?.kind).toBe('oracle');
  });

  it('spends gold at purchase, uses one scroll per counsel, never twice for the same counsel', async () => {
    const { db, ids: [alice] } = await setup('alice');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 1);
    expect(seekCounsel(db, alice, clinic, 1, 2)).toEqual({ ok: false, error: 'no_scroll', kind: 'insight' });
    buyScroll(db, alice, 'insight', 3);
    buyScroll(db, alice, 'insight', 4);
    expect(rangeScore(db, alice)).toBe(80);
    expect(scrollBag(db, alice)).toEqual({ insight: 2, revelation: 0, oracle: 0 });
    expect(seekCounsel(db, alice, clinic, 1, 5)).toMatchObject({ ok: true, used: true, hint: { id: 1 } });
    expect(seekCounsel(db, alice, clinic, 1, 6)).toMatchObject({ ok: true, used: false });
    expect(scrollBag(db, alice).insight).toBe(1);
    expect(rangeUnlockedTiers(db, alice, 'r01')).toEqual([1]);
    expect(rangeScore(db, alice)).toBe(80); // the counsel itself costs nothing more
    expect(seekCounsel(db, alice, clinic, 9, 7)).toEqual({ ok: false, error: 'unknown_tier' });
  });

  it('the leaderboard counts scroll spending like the score does', async () => {
    const { db, ids: [alice, bob] } = await setup('alice', 'bob');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 1);
    recordRangeSolve(db, bob, 'r01', 'acolyte', 100, 2);
    buyScroll(db, alice, 'oracle', 3);
    const rows = leaderboard(db);
    expect(rows.map((r) => [r.username, r.score])).toEqual([['bob', 100], ['alice', 70]]);
    expect(rangeScore(db, alice)).toBe(70);
  });
});
