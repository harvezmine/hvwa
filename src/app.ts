import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { openDb, migrate } from './db/index.js';
import { seed } from './db/seed.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { checkerRouter } from './core/checker.js';

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

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/api', checkerRouter(db));

  return app;
}
