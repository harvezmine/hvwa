// src/core/difficulty.ts
import type { RequestHandler } from 'express';
import type { Level } from './registry.js';

export const LEVELS: Level[] = ['acolyte', 'templar', 'inquisitor', 'divine'];

// Divine is the ASVS-aligned reference "view the fix" target, scored 0.
export const LEVEL_MULTIPLIER: Record<Level, number> = {
  acolyte: 1,
  templar: 1.5,
  inquisitor: 2,
  divine: 0,
};

export function isLevel(x: unknown): x is Level {
  return typeof x === 'string' && (LEVELS as string[]).includes(x);
}

export function resolveLevel(raw: unknown, fallback: Level = 'acolyte'): Level {
  return isLevel(raw) ? raw : fallback;
}

export function pointsForLevel(base: number, level: Level): number {
  return Math.round(base * LEVEL_MULTIPLIER[level]);
}

// Reads ?level= (or the hvwa_level cookie) and exposes it as req.level.
export function levelMiddleware(): RequestHandler {
  return (req, res, next) => {
    const raw = (req.query?.level as string | undefined) ?? (req as any).cookies?.hvwa_level;
    (req as any).level = resolveLevel(raw);
    next();
  };
}
