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

// req.level = valid ?level= → valid hvwa_level cookie → 'acolyte'.
// A valid ?level= is persisted in the hvwa_level cookie (only when it changes).
export function levelMiddleware(): RequestHandler {
  return (req, res, next) => {
    const fromQuery = req.query?.level;
    if (isLevel(fromQuery)) {
      if (req.cookies?.hvwa_level !== fromQuery) {
        res.cookie('hvwa_level', fromQuery, { httpOnly: true, sameSite: 'lax', path: '/' });
      }
      (req as any).level = fromQuery;
    } else {
      (req as any).level = resolveLevel(req.cookies?.hvwa_level);
    }
    next();
  };
}
