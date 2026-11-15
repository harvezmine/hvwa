// src/portal/index.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allChallenges, type Challenge } from '../core/registry.js';
import { scoreFor, progress } from '../core/scoreboard.js';
import { sendPage } from '../core/render.js';

/** The portal's own EJS views (the shared layout lives in core/views). */
export const portalViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
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
    await sendPage(res, view('index'), { title: res.locals.t('app.title'), districts });
  });

  r.get('/scoreboard', async (req, res) => {
    const sid = req.sessionId;
    await sendPage(res, view('scoreboard'), {
      title: res.locals.t('scoreboard.title'),
      score: scoreFor(db, sid),
      solved: progress(db, sid).solved,
    });
  });

  return r;
}
