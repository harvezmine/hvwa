// src/core/difficulty.ts — request-level difficulty selection.
import type { RequestHandler } from 'express';
import { isLevel } from './levels.js';
import { cookieOptionsWith, preference } from './cookies.js';

// req.level = valid ?level= → valid hvwa_level cookie → 'acolyte'.
// Challenge routes further clamp it to the challenge's implemented levels.
export function levelMiddleware(opts: { readonly secureCookies?: boolean } = {}): RequestHandler {
  const cookieOptions = cookieOptionsWith(opts.secureCookies === true);
  return (req, res, next) => {
    req.level = preference(req, res, { query: 'level', cookie: 'hvwa_level', isValid: isLevel, fallback: 'acolyte' }, cookieOptions);
    next();
  };
}
