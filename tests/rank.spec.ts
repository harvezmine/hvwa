// The adventurer rank (src/range/rank.ts): the ladder is shares of the full bounty, so every letter stays reachable;
// the next-rank gap; and the EN/ID names.
import { describe, it, expect } from 'vitest';
import { ladderFor, maxBounty, nextRank, pointsToNext, rankFor, rankName, RANK_SHARES } from '../src/range/rank.js';
import { loadRegistry } from '../src/lab-registry.js';

describe('adventurer rank (src/range/rank.ts)', () => {
  const ladder = ladderFor(2400);

  it('builds the E → S ladder from shares of the full bounty, rounded to 10 gold', () => {
    expect(ladder.map((r) => r.letter)).toEqual(['E', 'D', 'C', 'B', 'A', 'S']);
    expect(ladder.map((r) => r.minPoints)).toEqual([0, 240, 600, 1080, 1680, 2280]);
    expect(Object.values(RANK_SHARES).every((s, i, a) => i === 0 || s > a[i - 1])).toBe(true);
    // A tiny bounty still gets six strictly rising steps.
    const tiny = ladderFor(20).map((r) => r.minPoints);
    expect(tiny.every((m, i) => i === 0 || m > tiny[i - 1])).toBe(true);
  });

  it('the full bounty is each lab paid once, at its best scored tier; S is reachable', () => {
    expect(maxBounty([
      { difficulty: 'easy', levels: ['acolyte', 'templar', 'inquisitor', 'divine'] }, // 200
      { difficulty: 'hard', levels: ['inquisitor'] }, // 600
      { difficulty: 'medium', levels: ['divine'] }, // no flag: 0
    ])).toBe(800);
    const labs = loadRegistry('labs/registry.json').labs;
    const full = maxBounty(labs);
    expect(rankFor(full, ladderFor(full)).letter).toBe('S');
  });

  it('rankFor picks the highest rank at or below the points, starting at E', () => {
    expect(rankFor(-5, ladder).letter).toBe('E');
    expect(rankFor(0, ladder).letter).toBe('E');
    expect(rankFor(239, ladder).letter).toBe('E');
    expect(rankFor(240, ladder).letter).toBe('D');
    expect(rankFor(600, ladder).letter).toBe('C');
    expect(rankFor(1080, ladder).letter).toBe('B');
    expect(rankFor(1679, ladder).letter).toBe('B');
    expect(rankFor(1680, ladder).letter).toBe('A');
    expect(rankFor(2280, ladder).letter).toBe('S');
    expect(rankFor(99999, ladder).letter).toBe('S');
  });

  it('nextRank and pointsToNext report the gap, and stop at S', () => {
    expect(nextRank(0, ladder)?.letter).toBe('D');
    expect(pointsToNext(0, ladder)).toBe(240);
    expect(pointsToNext(230, ladder)).toBe(10);
    expect(pointsToNext(240, ladder)).toBe(360); // D → C at 600
    expect(nextRank(2280, ladder)).toBeUndefined();
    expect(pointsToNext(2280, ladder)).toBe(0);
    expect(pointsToNext(99999, ladder)).toBe(0);
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
