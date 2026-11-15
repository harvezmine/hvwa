// src/core/session.ts
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// Minimal raw-cookie fallback so the middleware works whether or not
// cookie-parser has already populated req.cookies (e.g. in isolated unit tests).
function readSidFromHeader(req: { headers: { cookie?: string } }): string | undefined {
  const raw = req.headers?.cookie ?? '';
  const m = /(?:^|;\s*)hvwa_sid=([^;]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function sessionMiddleware(): RequestHandler {
  return (req, res, next) => {
    let sid = (req.cookies?.hvwa_sid as string | undefined) ?? readSidFromHeader(req);
    if (!sid) {
      sid = randomUUID();
      res.cookie('hvwa_sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    (req as any).sessionId = sid;
    next();
  };
}
