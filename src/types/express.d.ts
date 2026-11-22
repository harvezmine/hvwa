// Request / locals fields set by HVWA's middleware. Typed here so handlers
// (including every challenge route) never need `(req as any)`.
import type { Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import type { Theme } from '../core/theme.js';
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
      /** Colour theme for the layout (themeMiddleware: ?theme= → hvwa_theme cookie → system). */
      uiTheme?: Theme;
      /** The page query the language and theme toggles keep, ending in '&' (themeMiddleware, keptQuery); '' if none. */
      prefQuery?: string;
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
        /** users.id of the signed-in account (portal mode keys range progress by it). */
        readonly userId?: number;
        readonly user?: string;
        readonly role?: 'player' | 'admin';
        readonly defaultPassword?: boolean;
        readonly csrf?: string;
      };
      /** standalone or portal (createApp): the layout switches the safety/footer copy on it. */
      mode?: 'standalone' | 'portal';
      /** Portal mode (src/range/index.ts): the range's navigation instead of Districts / Scoreboard. */
      portalNav?: { readonly admin: boolean; readonly active?: 'labs' | 'team' | 'leaderboard' | 'admin' };
      /** Portal mode: the My Lab chip in the header (src/range/panel.ts myLabChip). */
      myLab?: { readonly href: string; readonly state: string; readonly text: string };
    }
  }
}

export {};
