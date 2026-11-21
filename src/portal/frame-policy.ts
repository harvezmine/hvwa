// src/portal/frame-policy.ts — the portal's pages may be framed only by HVWA itself. Without this a same-SITE page
// (another port of 127.0.0.1: cookies ignore ports, so it is framed WITH the player's cookies) could frame
// /c/<id> or the scoreboard and click through them. Only frame-ancestors: no script, style or connect rule, so the
// layout and htmx work exactly as before.
//
// Mounted at the top of portalRouter, which runs only for requests no lab and no API route answered. Lab paths
// (/d/<district>/...) and the API are skipped even then: a lab's framing is its lesson, set per level by setLabHeaders
// (core/http.ts), and nothing else may add to it. The login and account pages carry the scoped page policy
// (core/page-csp.ts), mounted with the auth routers.
import type { RequestHandler } from 'express';

export const PORTAL_FRAME_POLICY = "frame-ancestors 'self'";

// A lab route is /d/<district>/<anything>; /d/<district> alone (or with a trailing slash) is the portal's district page.
const NOT_PORTAL = /^\/(?:api(?:\/|$)|d\/[^/]+\/.)/i;

export function portalFramePolicy(): RequestHandler {
  return (req, res, next) => {
    if (!NOT_PORTAL.test(req.path) && !res.headersSent && res.getHeader('Content-Security-Policy') === undefined) {
      res.setHeader('Content-Security-Policy', PORTAL_FRAME_POLICY);
    }
    next();
  };
}
