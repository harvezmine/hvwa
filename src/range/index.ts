// src/range/index.ts — the range portal (HVWA_MODE=portal, spec 2026-11-20 range). PLATFORM code: the labs it launches
// are the vulnerable part, this is not. createApp mounts `edge` before the session, `locals` right after the login
// gate, and `router` after the account pages.
import { Router, type RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformAuth } from '../auth/index.js';
import { hostnameOf, targetHostname } from '../core/host-guard.js';
import { portalFramePolicy } from '../portal/frame-policy.js';
import { catalogRoutes } from './catalog.js';
import { instanceIdOfHost } from './hosts.js';
import { createLifecycle, type Lifecycle } from './lifecycle.js';
import { reapOnce, reconcile, startReaper, type Reaper } from './reaper.js';
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
  /** Reconcile with the warden now (logged on failure), then reap every 30 s. server.ts calls it once listening. */
  start(): Reaper;
}

export function createRangePortal(db: DatabaseSync, auth: PlatformAuth, opts: RangePortalOptions): RangePortal {
  const now = opts.now ?? Date.now;
  const lifecycle = createLifecycle({
    db, warden: opts.warden, registry: opts.registry, rangeKey: opts.rangeKey, limits: opts.limits, now, log: opts.log,
  });
  const ctx: RangeContext = { db, auth, opts, registry: opts.registry, now, lifecycle };
  const isInstanceHost = (hostname: string) => instanceIdOfHost(hostname, opts.domain) !== undefined;
  const edgeHost = (h: string | null | undefined) => typeof h === 'string' && (h === opts.internalHost || isInstanceHost(h));

  // Fails closed until the gate and forward-auth exist (Tasks 20-21): a bare 404, no session cookie, never cached.
  // The Host header and an absolute-form target (which HTTP says overrides Host; the host guard checks both) count
  // alike, so neither can route an instance-host or internal-host request into the portal's pages.
  const edge: RequestHandler = (req, res, next) => {
    const ours = edgeHost(hostnameOf(req.headers.host)) || edgeHost(targetHostname(req.originalUrl));
    if (!ours && !/^\/__hvwa(?:\/|$)/i.test(req.path)) { next(); return; }
    res.set('Cache-Control', 'no-store');
    res.status(404).type('text/plain').send('Not found\n');
  };

  const locals: RequestHandler = (_req, res, next) => {
    res.locals.portalNav = { admin: res.locals.platformAuth?.role === 'admin' };
    next();
  };

  const router = Router();
  router.use(portalFramePolicy());
  catalogRoutes(router, ctx);
  const log = opts.log ?? ((line: string) => console.warn(line));
  const start = (): Reaper => {
    reconcile(lifecycle, opts.warden, now).catch((err: unknown) => {
      log(`HVWA range: startup reconcile failed (${err instanceof Error ? err.message : String(err)}); the reaper catches up`);
    });
    return startReaper(() => reapOnce(lifecycle, opts.warden, opts.limits, now));
  };
  return Object.freeze({ isInstanceHost, edge, locals, router, lifecycle, start });
}
