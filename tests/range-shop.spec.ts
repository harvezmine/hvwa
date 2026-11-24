// The merchant's scrolls and the Guildmaster's counsel (src/range/shop.ts): gold is spent when a scroll is bought, a
// scroll buys exactly one counsel of its own tier, a counsel already heard costs no second scroll, and the score and the
// leaderboard both count the scrolls.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService } from '../src/auth/service.js';
import { leaderboard, rangePurse, rangeScore, rangeUnlockedTiers, recordRangeSolve } from '../src/range/progress.js';
import {
  buyScroll, SCROLLS, scrollBag, scrollFor, seekCounsel, STARTER_PURSE, takeStarterNotice,
} from '../src/range/shop.js';
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

  it('every account holds the same starter purse, exactly one medium scroll; its popup shows once', async () => {
    const { db, ids: [alice, bob] } = await setup('alice', 'bob');
    expect(STARTER_PURSE).toBe(SCROLLS[1].price);
    expect(rangeScore(db, alice)).toBe(STARTER_PURSE);
    expect(rangeScore(db, bob)).toBe(STARTER_PURSE);
    expect(takeStarterNotice(db, alice, 1)).toBe(STARTER_PURSE);
    expect(takeStarterNotice(db, alice, 2)).toBeUndefined();
    expect(rangeScore(db, alice)).toBe(STARTER_PURSE); // seeing the popup changes nothing
    // It buys the medium scroll and nothing after it.
    expect(buyScroll(db, alice, 'revelation', 3)).toEqual({ ok: true });
    expect(rangeScore(db, alice)).toBe(0);
    expect(buyScroll(db, alice, 'insight', 4)).toEqual({ ok: false, error: 'poor', short: 10 });
    expect(scrollBag(db, alice)).toEqual({ insight: 0, revelation: 1, oracle: 0 });
  });

  it('refuses a scroll the purse cannot pay for in full: no tab, never below 0', async () => {
    const { db, ids: [alice] } = await setup('alice');
    expect(buyScroll(db, alice, 'oracle', 1)).toEqual({ ok: false, error: 'poor', short: 10 });
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 2); // 120 in the purse
    for (let i = 0; i < 3; i++) expect(buyScroll(db, alice, 'oracle', 3 + i).ok).toBe(true);
    expect(buyScroll(db, alice, 'revelation', 7).ok).toBe(true);
    expect(buyScroll(db, alice, 'insight', 8).ok).toBe(true);
    expect(rangePurse(db, alice)).toBe(0);
    expect(buyScroll(db, alice, 'insight', 9)).toEqual({ ok: false, error: 'poor', short: 10 });
    expect(rangePurse(db, alice)).toBe(0);
  });

  it('an old tab (bought before purchases were checked) is paid back by new bounties first', async () => {
    const { db, ids: [alice] } = await setup('alice');
    db.prepare("INSERT INTO range_scrolls (user_id, kind, cost, bought_at) VALUES (?, 'oracle', 30, 1), (?, 'oracle', 30, 1)").run(alice, alice);
    expect(rangePurse(db, alice)).toBe(-40);
    expect(rangeScore(db, alice)).toBe(0);
    expect(buyScroll(db, alice, 'insight', 2)).toEqual({ ok: false, error: 'poor', short: 10 });
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 3);
    expect(rangeScore(db, alice)).toBe(60);
  });

  it('spends gold at purchase, uses one scroll per counsel, never twice for the same counsel', async () => {
    const { db, ids: [alice] } = await setup('alice');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 1);
    expect(seekCounsel(db, alice, clinic, 1, 2)).toEqual({ ok: false, error: 'no_scroll', kind: 'insight' });
    buyScroll(db, alice, 'insight', 3);
    buyScroll(db, alice, 'insight', 4);
    expect(rangeScore(db, alice)).toBe(100);
    expect(scrollBag(db, alice)).toEqual({ insight: 2, revelation: 0, oracle: 0 });
    expect(seekCounsel(db, alice, clinic, 1, 5)).toMatchObject({ ok: true, used: true, hint: { id: 1 } });
    expect(seekCounsel(db, alice, clinic, 1, 6)).toMatchObject({ ok: true, used: false });
    expect(scrollBag(db, alice).insight).toBe(1);
    expect(rangeUnlockedTiers(db, alice, 'r01')).toEqual([1]);
    expect(rangeScore(db, alice)).toBe(100); // the counsel itself costs nothing more
    expect(seekCounsel(db, alice, clinic, 9, 7)).toEqual({ ok: false, error: 'unknown_tier' });
  });

  it('the leaderboard counts scroll spending like the score does', async () => {
    const { db, ids: [alice, bob] } = await setup('alice', 'bob');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 1);
    recordRangeSolve(db, bob, 'r01', 'acolyte', 100, 2);
    buyScroll(db, alice, 'oracle', 3);
    const rows = leaderboard(db);
    // Both hold the same starter purse, so only the scroll tells them apart; the board matches each player's gold.
    expect(rows.map((r) => [r.username, r.score])).toEqual([['bob', 120], ['alice', 90]]);
    expect(rangeScore(db, alice)).toBe(90);
    expect(rangeScore(db, bob)).toBe(120);
  });
});
