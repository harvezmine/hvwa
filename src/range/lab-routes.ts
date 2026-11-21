// src/range/lab-routes.ts — the range's lab actions (portal mode): flag submission, the Lab panel (fragment), launch,
// open (a gate ticket), reset, stop, and My Lab. Every POST is an account form (formOk: Origin, Sec-Fetch-Site, the
// token bound to hvwa_sid and hvwa_auth); htmx gets a fragment, a plain form a 303. The compact POC has no queue and no
// Extend: a full range refuses, the panel says so and offers Launch again.
import type { Request, Response, Router } from 'express';
import { field } from '../core/lab.js';
import { clampLevel, isLevel, type Level } from '../core/levels.js';
import { MY_LAB_VIEW, sendFragment } from '../core/render.js';
import type { LabEntry } from '../lab-registry.js';
import { isHtmx, rangeView, userOf } from './catalog.js';
import { instanceOrigin } from './hosts.js';
import { panelFor } from './panel.js';
import { submitRangeFlag, submitResultHtml } from './submit.js';
import type { RangeContext } from './types.js';

export function labRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth, lifecycle, opts } = ctx;
  const levelOf = (raw: unknown, lab: LabEntry): Level | undefined => (isLevel(raw) && lab.levels.includes(raw) ? raw : undefined);
  const sendPanel = async (req: Request, res: Response, lab: LabEntry, level: Level, notice?: 'full') => {
    res.set('Cache-Control', 'no-store');
    await sendFragment(res, rangeView('panel'), { panel: panelFor(ctx, req, res, lab, level, notice) });
  };

  router.post('/labs/:id/submit', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const result = submitRangeFlag(db, lifecycle.store, lab, userOf(res).userId, field(req, 'submission'), ctx.now());
    if (isHtmx(req)) { res.type('html').send(submitResultHtml(result, res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}?r=${result.status === 'wrong' ? 'wrong' : 'solved'}`);
  });

  // The panel (htmx polling): a starting instance is asked about once per poll.
  router.get('/labs/:id/panel', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    const level = levelOf(req.query.level, lab) ?? clampLevel(req.level, lab.levels);
    const current = lifecycle.current(userOf(res).userId);
    if (current?.state === 'starting') await lifecycle.refresh(current.id);
    await sendPanel(req, res, lab, level);
  });

  for (const action of ['launch', 'reset', 'stop'] as const) {
    router.post(`/labs/:id/${action}`, async (req, res, next) => {
      const lab = registry.get(req.params.id);
      if (!lab) { next(); return; }
      if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
      const level = levelOf(field(req, 'level'), lab);
      if (!level) { res.status(400).type('text/plain').send('Unknown level\n'); return; }
      const { userId } = userOf(res);
      const current = lifecycle.current(userId);
      let notice: 'full' | undefined;
      if (action === 'launch') {
        const outcome = await lifecycle.launch(userId, lab.id, level);
        if (!outcome.ok && outcome.error === 'full') notice = 'full';
      } else if (current && current.labId === lab.id) { // only the instance this panel shows
        if (action === 'reset') await lifecycle.reset(userId);
        else await lifecycle.stop(userId, 'user');
      }
      if (isHtmx(req)) { await sendPanel(req, res, lab, level, notice); return; }
      res.redirect(303, `/labs/${lab.id}?level=${level}${notice === 'full' ? '&r=full' : ''}`);
    });
  }

  // Open lab (spec §5.4): a single-use 60 s ticket for THIS user and instance, handed to the instance host's gate.
  router.post('/labs/:id/open', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const { userId } = userOf(res);
    const current = lifecycle.current(userId);
    if (!current || current.labId !== lab.id || current.state !== 'running') { res.redirect(303, `/labs/${lab.id}`); return; }
    const ticket = ctx.tickets.mint(userId, current.id);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(303, `${instanceOrigin(current.id, opts.domain, opts.publicScheme ?? 'https', opts.publicPort)}/__hvwa/gate?t=${ticket}`);
  });

  router.get('/my-lab', (_req, res) => {
    const current = lifecycle.current(userOf(res).userId);
    res.redirect(303, current ? `/labs/${current.labId}?level=${current.level}` : '/');
  });
  router.get('/my-lab/chip', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    await sendFragment(res, MY_LAB_VIEW);
  });
}
