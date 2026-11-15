import type { Router } from 'express';
import type { AdminLevel, Wiring } from '../model.js';

// DIVINE — deny by default. The guard is mounted FIRST and matches nothing: every path that
// reaches this router (all but the public landing page, robots.txt and openapi.json, which
// the challenge serves before it) needs the admin, so there is no spelling to normalize and
// no alias or forgotten route that can be reached around it. Unknown paths get the same answer.
// Out of scope here: a production system would also authenticate admins (MFA) and audit exports.
export const robots: AdminLevel['robots'] = ['Disallow: /admin/'];
export const openapi: AdminLevel['openapi'] = {
  '/admin/export': { summary: 'Member export (admin only)' },
};
export function install(router: Router, w: Wiring): void {
  router.use((req, res, next) => {
    if (!w.isAdmin(req)) { w.denied(req, res, next); return; }
    next();
  });
  router.get('/admin/export', w.exportPage);
}
