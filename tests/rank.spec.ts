// The adventurer rank (src/range/rank.ts): thresholds E → S, the next-rank gap, and the EN/ID names.
import { describe, it, expect } from 'vitest';
import { RANKS, rankFor, nextRank, pointsToNext, rankName } from '../src/range/rank.js';

describe('adventurer rank (src/range/rank.ts)', () => {
  it('has the E → S ladder with ascending thresholds', () => {
    expect(RANKS.map((r) => r.letter)).toEqual(['E', 'D', 'C', 'B', 'A', 'S']);
    expect(RANKS.map((r) => r.minPoints)).toEqual([0, 300, 1000, 2000, 3000, 3750]);
  });

  it('rankFor picks the highest rank at or below the points, starting at E', () => {
    expect(rankFor(-5).letter).toBe('E');
    expect(rankFor(0).letter).toBe('E');
    expect(rankFor(299).letter).toBe('E');
    expect(rankFor(300).letter).toBe('D');
    expect(rankFor(999).letter).toBe('D');
    expect(rankFor(1000).letter).toBe('C');
    expect(rankFor(1999).letter).toBe('C');
    expect(rankFor(2000).letter).toBe('B');
    expect(rankFor(2999).letter).toBe('B');
    expect(rankFor(3000).letter).toBe('A');
    expect(rankFor(3749).letter).toBe('A');
    expect(rankFor(3750).letter).toBe('S');
    expect(rankFor(99999).letter).toBe('S');
  });

  it('nextRank and pointsToNext report the gap, and stop at S', () => {
    expect(nextRank(0)?.letter).toBe('D');
    expect(pointsToNext(0)).toBe(300);
    expect(pointsToNext(290)).toBe(10);
    expect(pointsToNext(300)).toBe(700); // D → C at 1000
    expect(nextRank(3750)).toBeUndefined();
    expect(pointsToNext(3750)).toBe(0);
    expect(pointsToNext(99999)).toBe(0);
  });

  it('rank names are localised (EN/ID)', () => {
    expect(rankName('E', 'en')).toBe('Greenhorn');
    expect(rankName('E', 'id')).toBe('Anak Bawang');
    expect(rankName('D', 'en')).toBe('Pathfinder');
    expect(rankName('D', 'id')).toBe('Penjelajah');
    expect(rankName('C', 'en')).toBe('Sellsword');
    expect(rankName('B', 'en')).toBe('Knight-errant');
    expect(rankName('A', 'en')).toBe('Champion');
    expect(rankName('A', 'id')).toBe('Jawara');
    expect(rankName('S', 'en')).toBe('Legend');
    expect(rankName('S', 'id')).toBe('Legenda');
  });
});
