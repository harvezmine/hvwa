import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { setFlagSecret } from './core/flags.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { checkerRouter } from './core/checker.js';
import { portalRouter } from './portal/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  /** SQLite path. Defaults to an in-memory database (tests). */
  dbPath?: string;
  /** HMAC secret for flags. Defaults to a random per-process secret. */
  flagSecret?: string;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();

  setFlagSecret(opts.flagSecret ?? randomBytes(32).toString('hex'));

  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);
  seed(db);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware());
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.use('/static', express.static(join(here, 'public')));

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', checkerRouter(db));
  app.use('/', portalRouter(db));

  return app;
}
