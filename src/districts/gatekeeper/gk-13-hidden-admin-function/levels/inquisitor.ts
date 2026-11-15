import type { Router } from 'express';
import type { AdminLevel, Wiring } from '../model.js';

// INQUISITOR — the guard is right: it decodes, lower-cases and collapses the path before the
// prefix test, so no spelling of /admin slips past it. The flaw is ordering: a deprecated alias
// of the export, still documented in openapi.json, is mounted BEFORE the guard.
export const robots: AdminLevel['robots'] = ['Disallow: /admin/'];
export const openapi: AdminLevel['openapi'] = {
  '/admin/export': { summary: 'Member export (admin only)' },
  '/legacy/export-all': { summary: 'Old member export, replaced by /admin/export', deprecated: true },
};

function normalize(path: string): string {
  let p = path;
  try { p = decodeURIComponent(p); } catch { /* keep the raw spelling */ }
  return p.toLowerCase().replace(/\/+/g, '/');
}

export function install(router: Router, w: Wiring): void {
  router.get('/legacy/export-all', w.exportPage); // deprecated alias, mounted before the guard
  router.use((req, res, next) => {
    if (normalize(req.path).startsWith('/admin') && !w.isAdmin(req)) { w.denied(req, res, next); return; }
    next();
  });
  router.get('/admin/export', w.exportPage);
}
