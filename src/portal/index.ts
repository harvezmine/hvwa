// src/portal/index.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { allChallenges, type Challenge } from '../core/registry.js';
import { scoreFor, progress } from '../core/scoreboard.js';
import { page, portalViewsDir } from '../core/render.js';

const view = (name: string) => join(portalViewsDir, `${name}.ejs`);

// Reads only the registry; never imports a challenge directly.
// lang / t come from res.locals (langMiddleware).
export function portalRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    const byDistrict = new Map<string, Challenge[]>();
    for (const c of allChallenges()) {
      const list = byDistrict.get(c.district) ?? [];
      list.push(c);
      byDistrict.set(c.district, list);
    }
    const districts = [...byDistrict.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, challenges]) => ({ id, challenges }));
    res.send(await page(res, view('index'), { title: res.locals.t('app.title'), districts }));
  });

  r.get('/scoreboard', async (req, res) => {
    const sid = req.sessionId;
    res.send(await page(res, view('scoreboard'), {
      title: res.locals.t('scoreboard.title'),
      score: scoreFor(db, sid),
      solved: progress(db, sid).solved,
    }));
  });

  return r;
}
