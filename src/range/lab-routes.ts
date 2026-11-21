// src/range/lab-routes.ts — the range's lab actions (portal mode). Every POST is an account form (formOk: Origin,
// Sec-Fetch-Site, the token bound to hvwa_sid and hvwa_auth); htmx gets a fragment, a plain form a 303.
import type { Router } from 'express';
import { field } from '../core/lab.js';
import { isHtmx, userOf } from './catalog.js';
import { submitRangeFlag, submitResultHtml } from './submit.js';
import type { RangeContext } from './types.js';

export function labRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth, lifecycle } = ctx;

  router.post('/labs/:id/submit', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const result = submitRangeFlag(db, lifecycle.store, lab, userOf(res).userId, field(req, 'submission'), ctx.now());
    if (isHtmx(req)) { res.type('html').send(submitResultHtml(result, res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}?r=${result.status === 'wrong' ? 'wrong' : 'solved'}`);
  });
}
