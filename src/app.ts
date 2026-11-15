import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { checkerRouter } from './core/checker.js';
import { portalRouter } from './portal/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

  // Per-app in-memory database (deterministic seed). Exposed on app.locals
  // so routers that need it can reach it.
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  app.locals.db = db;

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
