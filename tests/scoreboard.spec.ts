import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/db/index.js';
import { recordSolve, scoreFor, progress } from '../src/core/scoreboard.js';
import { pointsForLevel } from '../src/core/levels.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { unlockHint } from '../src/core/hints.js';

register(defineChallenge({
  id: 'SB-01', district: 'test', dir: process.cwd(), slug: 'sb', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
  maps: [], levels: ['acolyte', 'templar', 'inquisitor', 'divine'], mount: () => {},
  hints: [
    { id: 1, text: { id: 'a', en: 'a' }, cost: 10 },
    { id: 2, text: { id: 'b', en: 'b' }, cost: 20 },
    { id: 3, text: { id: 'c', en: 'c' }, cost: 40 },
  ],
}));

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('scoreboard', () => {
  it('records a solve once and sums points', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100);
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100); // idempotent
    expect(scoreFor(db, 's1')).toBe(100);
    expect(progress(db, 's1').solved).toBe(1);
  });

  it('scores a templar solve at 1.5x base', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'templar', pointsForLevel(100, 'templar'));
    expect(scoreFor(db, 's1')).toBe(150);
  });

  it('upgrades to the better level: acolyte then inquisitor = 200', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'acolyte', pointsForLevel(100, 'acolyte'));
    recordSolve(db, 's1', 'GK-01', 'inquisitor', pointsForLevel(100, 'inquisitor'));
    expect(scoreFor(db, 's1')).toBe(200);
    expect(progress(db, 's1').solved).toBe(1);
  });

  it('keeps the best level: inquisitor then acolyte stays 200', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'inquisitor', pointsForLevel(100, 'inquisitor'));
    recordSolve(db, 's1', 'GK-01', 'acolyte', pointsForLevel(100, 'acolyte'));
    expect(scoreFor(db, 's1')).toBe(200);
    const row = db.prepare('SELECT level FROM solves WHERE session_id=? AND challenge_id=?').get('s1', 'GK-01');
    expect(row).toMatchObject({ level: 'inquisitor' });
  });

  it('sums across challenges and isolates sessions', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100);
    recordSolve(db, 's1', 'GK-02', 'templar', 150);
    recordSolve(db, 's2', 'GK-01', 'inquisitor', 200);
    expect(scoreFor(db, 's1')).toBe(250);
    expect(scoreFor(db, 's2')).toBe(200);
  });

  it('deducts unlocked hint costs: acolyte 100 - 40 hint = 60', () => {
    const db = fresh();
    recordSolve(db, 's1', 'SB-01', 'acolyte', 100);
    unlockHint(db, 's1', 'SB-01', 3);
    unlockHint(db, 's1', 'SB-01', 3); // unlocking twice costs once
    expect(scoreFor(db, 's1')).toBe(60);
  });

  it('floors the score at 0', () => {
    const db = fresh();
    unlockHint(db, 's1', 'SB-01', 1);
    unlockHint(db, 's1', 'SB-01', 2);
    unlockHint(db, 's1', 'SB-01', 3);
    expect(scoreFor(db, 's1')).toBe(0);
  });

  it('stores the hint cost at unlock time', () => {
    const db = fresh();
    unlockHint(db, 's1', 'SB-01', 2);
    expect(db.prepare('SELECT cost FROM hint_unlocks WHERE session_id=? AND challenge_id=? AND tier=?')
      .get('s1', 'SB-01', 2)).toMatchObject({ cost: 20 });
  });

  it('scores with the stored cost, not the registry (no retroactive changes)', () => {
    const db = fresh();
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100);
    // An unlock recorded for a challenge that is not (or no longer) registered.
    db.prepare("INSERT INTO hint_unlocks (session_id,challenge_id,tier,cost) VALUES ('s1','GONE-01',1,25)").run();
    expect(scoreFor(db, 's1')).toBe(75);
  });
});
