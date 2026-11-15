import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { setFlagSecret } from './core/flags.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { checkerRouter } from './core/checker.js';
import { errorHandler } from './core/errors.js';
import { portalRouter } from './portal/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Vendored htmx (pinned dependency), served locally — no network at runtime.
// Only this one file is exposed, not the rest of the package's dist/.
const htmxMinJs = join(
  dirname(createRequire(import.meta.url).resolve('htmx.org/package.json')), 'dist', 'htmx.min.js');

export interface AppOptions {
  /** SQLite path. Defaults to an in-memory database (tests). */
  dbPath?: string;
  /**
   * HMAC secret for flags (process-wide). When omitted, the current secret is
   * kept — by default a random value generated once per process in flags.ts.
   */
  flagSecret?: string;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();

  if (opts.flagSecret) setFlagSecret(opts.flagSecret);

  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);
  seed(db);
  // The app's DB handle: closed by server.ts on shutdown, and by tests that
  // use a file DB (Windows cannot delete a file SQLite still holds open).
  app.locals.db = db;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware());
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.get('/static/vendor/htmx.min.js', (_req, res, next) => {
    res.sendFile(htmxMinJs, (err) => { if (err) next(err); });
  });
  app.use('/static', express.static(join(here, 'public'), { index: false }));

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', checkerRouter(db));
  app.use('/', portalRouter(db));

  app.use(errorHandler()); // must stay last
  return app;
}
