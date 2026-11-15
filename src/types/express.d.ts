// Request / locals fields set by HVWA's middleware. Typed here so handlers
// (including every challenge route) never need `(req as any)`.
import type { Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import type { Challenge } from '../core/registry.js';

declare global {
  namespace Express {
    interface Request {
      /** UUID from the hvwa_sid cookie (sessionMiddleware). */
      sessionId: string;
      /**
       * Requested difficulty (levelMiddleware: ?level= → cookie → acolyte).
       * Under /d/<district>/<slug> it is clamped to the challenge's levels.
       */
      level: Level;
      /** UI language (langMiddleware: ?lang= → cookie → id). */
      lang: Lang;
    }
    interface Locals {
      lang: Lang;
      /** Platform-string translator bound to `lang`. */
      t: (key: string) => string;
      /** Clamped level; set only on challenge routes. */
      level?: Level;
      /** The challenge being served; set only on challenge routes. */
      challenge?: Challenge;
    }
  }
}

export {};
