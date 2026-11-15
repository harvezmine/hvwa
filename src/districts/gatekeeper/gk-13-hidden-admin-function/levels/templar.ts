import type { Router } from 'express';
import type { AdminLevel, Wiring } from '../model.js';

// TEMPLAR — a naive guard. The middleware protects paths that START WITH "/admin", compared
// case-sensitively, but Express routing is case-insensitive: "/Admin/export" is not caught
// by the middleware and still reaches the route. The route itself only asks for a signed-in caller
// (any role), so a pilgrim reaches an admin function: broken function-level authorization.
export const robots: AdminLevel['robots'] = ['Disallow: /admin/'];
export const openapi: AdminLevel['openapi'] = {
  '/admin/export': { summary: 'Member export (admin only)' },
};
export function install(router: Router, w: Wiring): void {
  router.use((req, res, next) => {
    if (req.path.startsWith('/admin') && !w.isAdmin(req)) { w.denied(req, res, next); return; }
    next();
  });
  router.get('/admin/export', w.requireSignIn, w.exportPage);
}
