// src/range/rank.ts — the adventurer rank (E → S). Pure: derives a letter, name key and progress from the player's
// total bounty points (src/range/progress.ts rangeScore). Every player starts at E; the thresholds run up to the
// maximum achievable bounty (~1750). No DB state: rank is always derived from the score.
import { t } from '../core/i18n.js';
import type { Lang } from '../core/i18n.js';

export interface RankStep {
  readonly letter: 'E' | 'D' | 'C' | 'B' | 'A' | 'S';
  readonly minPoints: number;
}

/** Thresholds, ascending. A score at or above minPoints earns that letter. */
export const RANKS: readonly RankStep[] = Object.freeze([
  Object.freeze({ letter: 'E', minPoints: 0 }),
  Object.freeze({ letter: 'D', minPoints: 200 }),
  Object.freeze({ letter: 'C', minPoints: 500 }),
  Object.freeze({ letter: 'B', minPoints: 900 }),
  Object.freeze({ letter: 'A', minPoints: 1300 }),
  Object.freeze({ letter: 'S', minPoints: 1750 }),
] as const);

/** The current rank for a point total (never undefined: everyone starts at E). */
export function rankFor(points: number): RankStep {
  let out: RankStep = RANKS[0];
  for (const step of RANKS) if (points >= step.minPoints) out = step;
  return out;
}

/** The next rank to earn, or undefined at the top (S). */
export function nextRank(points: number): RankStep | undefined {
  return RANKS.find((step) => points < step.minPoints);
}

/** Points still needed to reach the next rank (0 at the top). */
export function pointsToNext(points: number): number {
  const next = nextRank(points);
  return next ? next.minPoints - points : 0;
}

/** The localized rank name (e.g. "Adept"). */
export function rankName(letter: RankStep['letter'], lang: Lang): string {
  return t(`rank.name.${letter.toLowerCase()}`, lang);
}
