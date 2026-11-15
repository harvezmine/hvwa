import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/db/index.js';
import { recordSolve, scoreFor, progress } from '../src/core/scoreboard.js';
describe('scoreboard', () => {
  it('records a solve once and sums points', () => {
    const db = openDb(':memory:'); migrate(db);
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100);
    recordSolve(db, 's1', 'GK-01', 'acolyte', 100); // idempotent
    expect(scoreFor(db, 's1')).toBe(100);
    expect(progress(db, 's1').solved).toBe(1);
  });
});
