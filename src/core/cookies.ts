// src/core/cookies.ts — one cookie policy for every HVWA cookie, and the
// shared "query → cookie → fallback" preference resolver.
import type { CookieOptions, Request, Response } from 'express';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** hvwa_sid, hvwa_level and hvwa_lang all persist for a year. res.cookie copies this. */
export const COOKIE_OPTIONS: Readonly<CookieOptions> = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: ONE_YEAR_MS,
});

export interface PreferenceSpec<T extends string> {
  /** Query-string parameter, e.g. 'level'. */
  query: string;
  /** Cookie that remembers the choice, e.g. 'hvwa_level'. */
  cookie: string;
  isValid: (x: unknown) => x is T;
  fallback: T;
}

/**
 * Resolve a user preference: a valid ?<query> wins (and is persisted in the
 * cookie, only when it differs from the current cookie); otherwise a valid
 * cookie; otherwise the fallback.
 */
export function preference<T extends string>(req: Request, res: Response, spec: PreferenceSpec<T>): T {
  const fromQuery: unknown = req.query?.[spec.query];
  const fromCookie: unknown = req.cookies?.[spec.cookie];
  if (spec.isValid(fromQuery)) {
    if (fromCookie !== fromQuery) res.cookie(spec.cookie, fromQuery, COOKIE_OPTIONS);
    return fromQuery;
  }
  return spec.isValid(fromCookie) ? fromCookie : spec.fallback;
}
