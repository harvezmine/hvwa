// src/core/session.ts
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Requires cookie-parser to run first (createApp mounts it before this).
// An incoming hvwa_sid is accepted only if it is a UUID; anything else is
// replaced. The cookie is written only when a new session is issued.
export function sessionMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.cookies?.hvwa_sid;
    let sid: string;
    if (typeof incoming === 'string' && UUID_RE.test(incoming)) {
      sid = incoming;
    } else {
      sid = randomUUID();
      res.cookie('hvwa_sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    req.sessionId = sid;
    next();
  };
}
