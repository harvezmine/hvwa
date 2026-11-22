// The adventurer rank (src/range/rank.ts): thresholds E → S, the next-rank gap, and the EN/ID names.
import { describe, it, expect } from 'vitest';
import { RANKS, rankFor, nextRank, pointsToNext, rankName } from '../src/range/rank.js';

describe('adventurer rank (src/range/rank.ts)', () => {
  it('has the E → S ladder with ascending thresholds', () => {
    expect(RANKS.map((r) => r.letter)).toEqual(['E', 'D', 'C', 'B', 'A', 'S']);
    expect(RANKS.map((r) => r.minPoints)).toEqual([0, 200, 500, 900, 1300, 1750]);
  });

  it('rankFor picks the highest rank at or below the points, starting at E', () => {
    expect(rankFor(-5).letter).toBe('E');
    expect(rankFor(0).letter).toBe('E');
    expect(rankFor(199).letter).toBe('E');
    expect(rankFor(200).letter).toBe('D');
    expect(rankFor(499).letter).toBe('D');
    expect(rankFor(500).letter).toBe('C');
    expect(rankFor(899).letter).toBe('C');
    expect(rankFor(900).letter).toBe('B');
    expect(rankFor(1299).letter).toBe('B');
    expect(rankFor(1300).letter).toBe('A');
    expect(rankFor(1749).letter).toBe('A');
    expect(rankFor(1750).letter).toBe('S');
    expect(rankFor(99999).letter).toBe('S');
  });

  it('nextRank and pointsToNext report the gap, and stop at S', () => {
    expect(nextRank(0)?.letter).toBe('D');
    expect(pointsToNext(0)).toBe(200);
    expect(pointsToNext(190)).toBe(10);
    expect(pointsToNext(200)).toBe(300); // D → C at 500
    expect(nextRank(1750)).toBeUndefined();
    expect(pointsToNext(1750)).toBe(0);
    expect(pointsToNext(99999)).toBe(0);
  });

  it('rank names are localised (EN/ID)', () => {
    expect(rankName('E', 'en')).toBe('Initiate');
    expect(rankName('E', 'id')).toBe('Pemula');
    expect(rankName('D', 'en')).toBe('Scout');
    expect(rankName('D', 'id')).toBe('Pengintai');
    expect(rankName('C', 'en')).toBe('Adept');
    expect(rankName('B', 'en')).toBe('Veteran');
    expect(rankName('A', 'en')).toBe('Elite');
    expect(rankName('A', 'id')).toBe('Elit');
    expect(rankName('S', 'en')).toBe('Legend');
    expect(rankName('S', 'id')).toBe('Legenda');
  });
});
