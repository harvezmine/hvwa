// src/range/rank.ts — the adventurer rank (E → S). Pure: derives a letter, name key and progress from the player's
// gold (src/range/progress.ts rangeScore). Every player starts at E. The thresholds are shares of the guild's full
// bounty (every lab's best scored tier, maxBounty), so the ladder stays reachable and fair as labs are added: S always
// means nearly every bounty on every board, with a little room for scrolls bought along the way.
import { t } from '../core/i18n.js';
import type { Lang } from '../core/i18n.js';
import { FLAG_LEVELS } from '../core/levels.js';
import { labPoints, type LabEntry } from '../lab-registry.js';

export interface RankStep {
  readonly letter: 'E' | 'D' | 'C' | 'B' | 'A' | 'S';
  readonly minPoints: number;
}
export type RankLadder = readonly RankStep[];

/** The share of the full bounty each letter needs. */
export const RANK_SHARES: Readonly<Record<RankStep['letter'], number>> = Object.freeze({ E: 0, D: 0.1, C: 0.25, B: 0.45, A: 0.7, S: 0.95 });

/** The most gold the labs can pay: each lab's best scored tier (a lab is paid once, for its best tier). */
export function maxBounty(labs: readonly Pick<LabEntry, 'difficulty' | 'levels'>[]): number {
  let sum = 0;
  for (const lab of labs) {
    const scored = lab.levels.filter((l) => FLAG_LEVELS.includes(l));
    if (scored.length > 0) sum += Math.max(...scored.map((l) => labPoints(lab, l)));
  }
  return sum;
}

/** The ladder for a full bounty: thresholds rounded to 10 gold, strictly ascending (a tiny bounty still has 6 steps). */
export function ladderFor(fullBounty: number): RankLadder {
  const letters = Object.keys(RANK_SHARES) as RankStep['letter'][];
  const out: RankStep[] = [];
  let prev = -1;
  for (const letter of letters) {
    const min = letter === 'E' ? 0 : Math.max(prev + 10, Math.round((fullBounty * RANK_SHARES[letter]) / 10) * 10);
    out.push(Object.freeze({ letter, minPoints: min }));
    prev = min;
  }
  return Object.freeze(out);
}

/** The current rank for a point total (never undefined: everyone starts at E). */
export function rankFor(points: number, ladder: RankLadder): RankStep {
  let out: RankStep = ladder[0];
  for (const step of ladder) if (points >= step.minPoints) out = step;
  return out;
}

/** The next rank to earn, or undefined at the top (S). */
export function nextRank(points: number, ladder: RankLadder): RankStep | undefined {
  return ladder.find((step) => points < step.minPoints);
}

/** Points still needed to reach the next rank (0 at the top). */
export function pointsToNext(points: number, ladder: RankLadder): number {
  const next = nextRank(points, ladder);
  return next ? next.minPoints - points : 0;
}

/** The localized rank name (e.g. "Adept"). */
export function rankName(letter: RankStep['letter'], lang: Lang): string {
  return t(`rank.name.${letter.toLowerCase()}`, lang);
}
