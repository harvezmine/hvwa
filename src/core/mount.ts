// src/core/mount.ts — the engine mounts every registered challenge.
import { Router, type Express, type Request } from 'express';
import { allChallenges, type Challenge } from './registry.js';
import { clampLevel } from './levels.js';
import { issueFlag } from './flags.js';
import { mountVictim } from './victim.js';

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
export const DEFAULT_RESET_COOLDOWN_MS = 10_000;
const MAX_COOLDOWN_ENTRIES = 5000;

export function mountChallenges(app: Express, opts: { now?: () => number } = {}): void {
  const now = opts.now ?? Date.now;
  for (const c of allChallenges()) {
    const router = Router();
    router.use((req, res, next) => {
      req.level = clampLevel(req.level, c.levels);
      res.locals.level = req.level;
      res.locals.challenge = c;
      // Canonical lab path: req.baseUrl echoes the request's spelling (/D/GATEKEEPER/...), which would
      // give wrong links and cookie paths (browsers match cookie paths case-sensitively).
      res.locals.labPath = challengePath(c);
      // The lab bar's one-shot notice after a refused restart: a closed set, never echoed text.
      if (req.query.restart === 'cooldown') res.locals.restartNotice = 'cooldown';
      next();
    });
    const reset = c.reset;
    if (reset) {
      // Safety net: a reset may never become a free retry loop, whatever the lab's hook clears.
      const cooldownMs = c.resetCooldownMs ?? DEFAULT_RESET_COOLDOWN_MS;
      const last = new Map<string, number>(); // `${level}|${sid}` -> time of the last reset (insertion order = age)
      router.post('/_reset', (req, res) => {
        const key = `${req.level}|${req.sessionId}`;
        const t = now();
        const prev = last.get(key);
        if (prev !== undefined && t - prev < cooldownMs) {
          if (req.accepts(['json', 'html']) === 'html' && req.get('accept')?.includes('text/html')) {
            res.redirect(303, `${challengePath(c)}?level=${req.level}&restart=cooldown`); // browser: back to the lab, with a notice
            return;
          }
          res.status(429).type('text/plain').send(`Restart is cooling down. Try again in ${Math.ceil((cooldownMs - (t - prev)) / 1000)} s.`);
          return;
        }
        last.delete(key);
        last.set(key, t);
        if (last.size > MAX_COOLDOWN_ENTRIES) last.delete(last.keys().next().value as string);
        reset(req);
        res.redirect(303, `${challengePath(c)}?level=${req.level}`);
      });
    }
    // A simulated victim (core/victim.ts): its panel and POST <lab>/victim/<name> routes, before the lab's routes.
    if (c.victim) mountVictim(router, c.victim);
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
