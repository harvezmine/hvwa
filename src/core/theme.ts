// src/core/theme.ts — the colour theme preference (the layout's light/dark toggle).
import type { RequestHandler } from 'express';
import { preference } from './cookies.js';

/** 'system' follows prefers-color-scheme (no data-theme on <html>); 'dark' / 'light' are explicit choices. */
export const THEMES = Object.freeze(['system', 'dark', 'light'] as const);
export type Theme = (typeof THEMES)[number];

export function isTheme(x: unknown): x is Theme {
  return typeof x === 'string' && (THEMES as readonly string[]).includes(x);
}

/**
 * res.locals.uiTheme = valid ?theme= → valid hvwa_theme cookie → 'system' (the same query → cookie → fallback
 * resolver as ?lang= and ?level=). Presentation only: the toggle is a plain link, so it works without JavaScript,
 * and the server renders the chosen theme on the next page (no flash of the wrong theme).
 */
export function themeMiddleware(): RequestHandler {
  return (req, res, next) => {
    res.locals.uiTheme = preference<Theme>(req, res, { query: 'theme', cookie: 'hvwa_theme', isValid: isTheme, fallback: 'system' });
    next();
  };
}
