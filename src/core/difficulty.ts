// src/core/difficulty.ts — request-level difficulty selection.
import type { RequestHandler } from 'express';
import { isLevel, type Level } from './levels.js';

const DEFAULT_LEVEL: Level = 'acolyte';

// req.level = valid ?level= → valid hvwa_level cookie → 'acolyte'.
// A valid ?level= is persisted in the hvwa_level cookie (only when it changes).
export function levelMiddleware(): RequestHandler {
  return (req, res, next) => {
    const fromQuery = req.query?.level;
    if (isLevel(fromQuery)) {
      if (req.cookies?.hvwa_level !== fromQuery) {
        res.cookie('hvwa_level', fromQuery, { httpOnly: true, sameSite: 'lax', path: '/' });
      }
      req.level = fromQuery;
    } else {
      const fromCookie = req.cookies?.hvwa_level;
      req.level = isLevel(fromCookie) ? fromCookie : DEFAULT_LEVEL;
    }
    next();
  };
}
