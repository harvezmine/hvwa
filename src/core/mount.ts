// src/core/mount.ts — the engine mounts every registered challenge.
import { Router, type Express, type Request } from 'express';
import { allChallenges, type Challenge } from './registry.js';
import { clampLevel } from './levels.js';
import { issueFlag } from './flags.js';

/** URL prefix a challenge is served under: /d/<district>/<slug>. */
export function challengePath(c: Pick<Challenge, 'district' | 'slug'>): string {
  return `/d/${c.district}/${c.slug}`;
}

/**
 * Mount every challenge registered so far at /d/<district>/<slug>. Each gets
 * its own Router whose first middleware clamps req.level to the challenge's
 * implemented levels and sets res.locals.level / res.locals.challenge; then
 * challenge.mount(router) attaches its RELATIVE routes. Called by createApp()
 * after the API routes and before the 404/error handlers, so errors thrown in
 * challenge routes get the stack-free error handler.
 */
export function mountChallenges(app: Express): void {
  for (const c of allChallenges()) {
    const router = Router();
    router.use((req, res, next) => {
      req.level = clampLevel(req.level, c.levels);
      res.locals.level = req.level;
      res.locals.challenge = c;
      next();
    });
    c.mount(router);
    app.use(challengePath(c), router);
  }
}

/**
 * The flag for this request's session at the challenge's clamped level, so
 * authors never repeat the id string. Throws for Divine (Divine never issues
 * a flag); the error handler turns that into a stack-free 500.
 */
export function flagFor(
  req: Pick<Request, 'sessionId' | 'level'>,
  challenge: Pick<Challenge, 'id' | 'levels'>,
): string {
  return issueFlag(challenge.id, req.sessionId, clampLevel(req.level, challenge.levels));
}
