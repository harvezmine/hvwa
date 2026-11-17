// Request / locals fields set by HVWA's middleware. Typed here so handlers
// (including every challenge route) never need `(req as any)`.
import type { Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import type { Challenge } from '../core/registry.js';
import type { SimPanel } from '../core/victim.js';

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
      /** UI language (langMiddleware: ?lang= → cookie → en). */
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
      /** The simulated-victim panel, built at render time; set only on routes of a challenge with a victim. */
      simPanel?: () => SimPanel;
      /**
       * The platform login's state for the layout (src/auth): set only when auth is on. Signed in: the
       * account bar (logout form with its CSRF token) and, while the default password is in use, the banner.
       */
      platformAuth?: {
        readonly signedIn: boolean;
        readonly user?: string;
        readonly defaultPassword?: boolean;
        readonly csrf?: string;
      };
    }
  }
}

export {};
