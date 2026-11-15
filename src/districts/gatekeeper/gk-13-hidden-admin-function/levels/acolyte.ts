import type { Router } from 'express';
import type { AdminLevel, Wiring } from '../model.js';

// ACOLYTE — no defense. The export is simply "not linked": nothing asks who the caller is,
// and robots.txt even tells crawlers (and players) where it lives.
export const robots: AdminLevel['robots'] = ['Disallow: /admin/export'];
export const openapi: AdminLevel['openapi'] = {};
export function install(router: Router, w: Wiring): void {
  router.get('/admin/export', w.exportPage);
}
