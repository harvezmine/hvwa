import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db/index.js';
import { setFlagSecret } from './core/flags.js';
import { hostGuard } from './core/host-guard.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { checkerRouter } from './core/checker.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import { mountChallenges } from './core/mount.js';
import { portalRouter } from './portal/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Vendored htmx (pinned dependency), served locally — no network at runtime.
// Only this one file is exposed, not the rest of the package's dist/.
// sendFile gets it as a root + name: with a bare absolute path, send's
// dotfiles check covers every segment, so a checkout under any dot-directory
// (.worktrees/, ~/.local/...) would answer 404.
const htmxDistDir = join(
  dirname(createRequire(import.meta.url).resolve('htmx.org/package.json')), 'dist');

export interface AppOptions {
  /** SQLite path. Defaults to an in-memory database (tests). */
  dbPath?: string;
  /**
   * HMAC secret for flags. PROCESS-WIDE: the flag secret is a single module
   * value in core/flags.ts shared by every app in this process, so passing it
   * here changes it for all of them. When omitted, the current secret is kept
   * (by default a random value generated once per process). server.ts always
   * passes the env/persisted secret.
   */
  flagSecret?: string;
  /**
   * Extra Host names to answer to, besides localhost / 127.0.0.1 / [::1]
   * (DNS-rebinding guard). server.ts passes HVWA_ALLOWED_HOSTS.
   */
  allowedHosts?: readonly string[];
}

/** The Express app plus its typed platform DB handle on `locals.db`. */
export type HvwaApp = Express & { locals: { db: DatabaseSync } };

export function createApp(opts: AppOptions = {}): HvwaApp {
  if (opts.flagSecret) setFlagSecret(opts.flagSecret);

  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);

  // The app's DB handle: closed by server.ts on shutdown, and by tests that
  // use a file DB (Windows cannot delete a file SQLite still holds open).
  // Object.assign keeps the same locals object and yields the typed shape.
  const base = express();
  const app: HvwaApp = Object.assign(base, { locals: Object.assign(base.locals, { db }) });

  // FIRST: requests for a foreign Host (DNS rebinding) never reach anything else.
  app.use(hostGuard(opts.allowedHosts));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware());
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.get('/static/vendor/htmx.min.js', (_req, res, next) => {
    res.sendFile('htmx.min.js', { root: htmxDistDir }, (err) => { if (err) next(err); });
  });
  app.use('/static', express.static(join(here, 'public'), { index: false }));

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', checkerRouter(db));
  mountChallenges(app); // every registered challenge at /d/<district>/<slug>
  app.use('/', portalRouter(db));

  app.use(notFoundHandler());
  app.use(errorHandler()); // must stay last
  return app;
}
