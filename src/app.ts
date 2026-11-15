import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  return app;
}
