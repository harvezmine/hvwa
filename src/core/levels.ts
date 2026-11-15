// src/core/levels.ts — the single source of truth for difficulty levels.

/** All levels in rank order (index = rank). Divine is the secure reference. */
export const LEVELS = Object.freeze(['acolyte', 'templar', 'inquisitor', 'divine'] as const);

export type Level = (typeof LEVELS)[number];

/** Levels that can be exploited and therefore issue a flag (everything but Divine). */
export const FLAG_LEVELS: readonly Level[] = Object.freeze(LEVELS.filter((l) => l !== 'divine'));

/** Score multiplier per level. Divine is the "view the fix" target, scored 0. */
export const LEVEL_MULTIPLIER: Readonly<Record<Level, number>> = Object.freeze({
  acolyte: 1,
  templar: 1.5,
  inquisitor: 2,
  divine: 0,
});

export function isLevel(x: unknown): x is Level {
  return typeof x === 'string' && (LEVELS as readonly string[]).includes(x);
}

/** 0 = acolyte … 3 = divine. */
export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

export function pointsForLevel(base: number, level: Level): number {
  return Math.round(base * LEVEL_MULTIPLIER[level]);
}

/**
 * The level a challenge actually serves for a requested level: the highest
 * implemented level ranked at or below the request, or — if none is — the
 * lowest implemented level. `implemented` must be non-empty (the registry
 * guarantees it).
 */
export function clampLevel(requested: Level, implemented: readonly Level[]): Level {
  const sorted = [...implemented].sort((a, b) => levelRank(a) - levelRank(b));
  if (sorted.length === 0) throw new Error('clampLevel: no implemented levels');
  const atOrBelow = sorted.filter((l) => levelRank(l) <= levelRank(requested));
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : sorted[0];
}
