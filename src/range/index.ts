// src/range/index.ts — the range portal (HVWA_MODE=portal, spec 2026-11-20 range). PLATFORM code: the labs it launches
// are the vulnerable part, this is not. createApp mounts `edge` before the session, `locals` right after the login
// gate, and `router` after the account pages.
import { Router, type RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformAuth } from '../auth/index.js';
import { SCOPED_PAGE_CSP } from '../core/page-csp.js';
import { portalFramePolicy } from '../portal/frame-policy.js';
import { catalogRoutes } from './catalog.js';
import { edgeHandler } from './gate.js';
import { instanceIdOfHost } from './hosts.js';
import { labRoutes } from './lab-routes.js';
import { createLifecycle, type Lifecycle } from './lifecycle.js';
import { myLabChip } from './panel.js';
import { rangeScore } from './progress.js';
import { rankFor } from './rank.js';
import { reapOnce, reconcile, startReaper, type Reaper } from './reaper.js';
import { createTicketStore, type TicketStore } from './tickets.js';
import type { RangeContext, RangePortalOptions } from './types.js';

export type { RangeLimits, RangePortalOptions } from './types.js';
export { DEFAULT_LIMITS } from './types.js';

export interface RangePortal {
  /** Instance hosts (i-<id>.<domain>): the host guard lets them through, and only `edge` answers them. */
  readonly isInstanceHost: (hostname: string) => boolean;
  /** Before the session: every request on an instance host or the internal host ends here, as does /__hvwa/* anywhere. */
  readonly edge: RequestHandler;
  /** Right after the login gate: the layout's range navigation. */
  readonly locals: RequestHandler;
  /** After the account pages: the range's own pages. */
  readonly router: Router;
  /** The instance lifecycle (server.ts starts its reaper; the panels use it). */
  readonly lifecycle: Lifecycle;
  /** The gate tickets ("Open lab" mints one; /__hvwa/gate spends it). */
  readonly tickets: TicketStore;
  /** Reconcile with the warden now (logged on failure), then reap every 30 s. server.ts calls it once listening. */
  start(): Reaper;
}

export function createRangePortal(db: DatabaseSync, auth: PlatformAuth, opts: RangePortalOptions): RangePortal {
  const now = opts.now ?? Date.now;
  const lifecycle = createLifecycle({
    db, warden: opts.warden, registry: opts.registry, rangeKey: opts.rangeKey, limits: opts.limits, now, log: opts.log,
  });
  const tickets = createTicketStore({ now });
  const ctx: RangeContext = { db, auth, opts, registry: opts.registry, now, lifecycle, tickets };
  const isInstanceHost = (hostname: string) => instanceIdOfHost(hostname, opts.domain) !== undefined;
  // The gate on instance hosts, 404 for the rest of them, the internal host and /__hvwa/* anywhere (src/range/gate.ts).
  const edge = edgeHandler(ctx);

  const locals: RequestHandler = (req, res, next) => {
    const active = req.path === '/leaderboard' ? 'leaderboard'
      : req.path === '/' || req.path.startsWith('/labs/') ? 'labs' : undefined;
    res.locals.portalNav = { admin: res.locals.platformAuth?.role === 'admin', active };
    const userId = res.locals.platformAuth?.userId;
    if (userId !== undefined) {
      // An active or recently ended instance (the chip hides itself when there is neither).
      res.locals.myLab = myLabChip(lifecycle.store.latestForUser(userId), opts.registry, now(), res.locals.t);
      // The adventurer rank for the account menu, derived from the player's bounty (no DB state).
      const letter = rankFor(rangeScore(db, userId)).letter;
      res.locals.playerRank = { letter, name: res.locals.t(`rank.name.${letter.toLowerCase()}`) };
    }
    next();
  };

  const router = Router();
  // Per-user pages and fragments: never cached by a shared cache, and keyed on the session cookie. The CSP is the
  // portal's own (no inline script or style); labs run in their own containers and keep their own headers.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', SCOPED_PAGE_CSP);
    next();
  });
  router.use(portalFramePolicy());
  catalogRoutes(router, ctx);
  labRoutes(router, ctx);
  const log = opts.log ?? ((line: string) => console.warn(line));
  const start = (): Reaper => {
    reconcile(lifecycle, opts.warden, now).catch((err: unknown) => {
      log(`HVWA range: startup reconcile failed (${err instanceof Error ? err.message : String(err)}); the reaper catches up`);
    });
    return startReaper(() => reapOnce(lifecycle, opts.warden, opts.limits, now));
  };
  return Object.freeze({ isInstanceHost, edge, locals, router, lifecycle, tickets, start });
}
