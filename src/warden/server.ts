// src/warden/server.ts — the warden's HTTP API (spec range §3): reachable on the internal `control` network only, and
// every /v1 route needs `Authorization: Bearer <HVWA_WARDEN_SECRET>` (compared in constant time through SHA-256). The
// JSON parser runs only after the secret and takes 4 KiB at most; the launch schema refuses every key but six ids.
//   POST   /v1/instances               { labId, level, instanceId, flag?, userId, expiresAt } -> 201 { instanceId }
//   DELETE /v1/instances/:id            -> 204 (idempotent)
//   GET    /v1/instances                -> 200 { instances: ListedInstance[] }
//   GET    /v1/instances/:id/health     -> 200 { status, reason? }
//   GET    /healthz                     -> 200 { status: 'ok' } (no secret: compose's health check)
import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { INSTANCE_ID_RE } from '../range/ids.js';
import { DockerError } from './docker.js';
import { WardenError, type LaunchRequest, type WardenApi } from './protocol.js';

export function createWardenServer(opts: { readonly warden: WardenApi; readonly secret: string }): Express {
  const want = createHash('sha256').update(opts.secret, 'utf8').digest();
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

  const requireSecret: RequestHandler = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : `\u0000${header}`;
    if (timingSafeEqual(createHash('sha256').update(presented, 'utf8').digest(), want)) { next(); return; }
    res.status(401).json({ error: 'unauthorized' });
  };
  app.use(requireSecret);
  app.use(express.json({ limit: '4kb' }));

  const fail = (res: Response, err: unknown) => {
    if (err instanceof WardenError) { res.status(err.status).json({ error: err.code }); return; }
    if (err instanceof DockerError) { res.status(502).json({ error: 'docker' }); return; }
    res.status(500).json({ error: 'internal' });
  };
  const badId = (id: string, res: Response) => {
    if (INSTANCE_ID_RE.test(id)) return false;
    res.status(400).json({ error: 'bad_request' });
    return true;
  };

  app.post('/v1/instances', async (req, res) => {
    try {
      await opts.warden.launch(req.body as LaunchRequest);
      res.status(201).json({ instanceId: (req.body as LaunchRequest).instanceId });
    } catch (err) { fail(res, err); }
  });
  app.delete('/v1/instances/:id', async (req, res) => {
    if (badId(req.params.id, res)) return;
    try { await opts.warden.stop(req.params.id); res.status(204).end(); } catch (err) { fail(res, err); }
  });
  app.get('/v1/instances', async (_req, res) => {
    try { res.json({ instances: await opts.warden.list() }); } catch (err) { fail(res, err); }
  });
  app.get('/v1/instances/:id/health', async (req, res) => {
    if (badId(req.params.id, res)) return;
    try { res.json(await opts.warden.health(req.params.id)); } catch (err) { fail(res, err); }
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status === 413) { res.status(413).json({ error: 'too_large' }); return; }
    res.status(status >= 400 && status < 500 ? 400 : 500).json({ error: status >= 400 && status < 500 ? 'bad_request' : 'internal' });
  };
  app.use(onError);
  return app;
}
