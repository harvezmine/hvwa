// src/core/session.ts
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { cookieOptionsWith } from './cookies.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE = 60;

export interface SessionOptions {
  /** Most NEW sessions issued per rolling minute (default 60). Beyond it the request is a 429 and no cookie is set. */
  maxNewPerMinute?: number;
  /** Clock in ms (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Secure on hvwa_sid: true when the browser speaks https (portal mode); false for a local http run. */
  secureCookies?: boolean;
}

// Requires cookie-parser to run first (createApp mounts it before this).
// An incoming hvwa_sid is accepted only if it is a UUID; anything else is
// replaced. The cookie is written only when a new session is issued.
//
// Issuance is rate limited: a per-player lab (core/lab.ts perSession) that is evicted is reset, so
// minting sessions must be too slow to flood it. Existing sessions are never limited; /healthz is
// exempt (it holds no state). NOTE: any well-formed UUID cookie is accepted as a session (the
// platform has no session table), so a client can also invent ids; perSession has its own
// new-instance limit for exactly that reason.
export function sessionMiddleware(opts: SessionOptions = {}): RequestHandler {
  const { maxNewPerMinute = DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE, now = Date.now } = opts;
  if (!Number.isInteger(maxNewPerMinute) || maxNewPerMinute < 1) {
    throw new Error(`sessionMiddleware: maxNewPerMinute must be a positive integer (got ${String(maxNewPerMinute)})`);
  }
  const cookieOptions = cookieOptionsWith(opts.secureCookies === true);
  const issued: number[] = [];
  return (req, res, next) => {
    const incoming = req.cookies?.hvwa_sid;
    let sid: string;
    if (typeof incoming === 'string' && UUID_RE.test(incoming)) {
      sid = incoming;
    } else {
      if (req.path !== '/healthz') {
        const t = now();
        while (issued.length > 0 && t - issued[0] >= 60_000) issued.shift();
        if (issued.length >= maxNewPerMinute) {
          res.status(429).type('text/plain').send('Too many new sessions — keep your cookie jar.');
          return;
        }
        issued.push(t);
      }
      sid = randomUUID();
      res.cookie('hvwa_sid', sid, cookieOptions);
    }
    req.sessionId = sid;
    next();
  };
}
