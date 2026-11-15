// src/portal/index.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { renderFile } from 'ejs';
import { join } from 'node:path';
import { allChallenges, type Challenge } from '../core/registry.js';
import { scoreFor, progress } from '../core/scoreboard.js';
import { portalViewsDir } from '../core/render.js';
import { t, type Lang } from '../core/i18n.js';

// Render a content view then wrap it in the shared layout (poor-man's layouting
// without an extra dependency).
async function page(view: string, data: Record<string, unknown>, lang: Lang): Promise<string> {
  const tt = (key: string) => t(key, lang);
  const ctx = { ...data, lang, t: tt };
  const body = await renderFile(join(portalViewsDir, `${view}.ejs`), ctx);
  return renderFile(join(portalViewsDir, 'layout.ejs'), { ...ctx, body });
}

export function portalRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const lang = (req as any).lang as Lang;
    const byDistrict = new Map<string, Challenge[]>();
    for (const c of allChallenges()) {
      const list = byDistrict.get(c.district) ?? [];
      list.push(c);
      byDistrict.set(c.district, list);
    }
    const districts = [...byDistrict.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, challenges]) => ({ id, challenges }));
    res.send(await page('index', { title: t('app.title', lang), districts }, lang));
  });

  r.get('/scoreboard', async (req, res) => {
    const lang = (req as any).lang as Lang;
    const sid = (req as any).sessionId as string;
    res.send(
      await page(
        'scoreboard',
        {
          title: t('scoreboard.title', lang),
          score: scoreFor(db, sid),
          solved: progress(db, sid).solved,
        },
        lang,
      ),
    );
  });

  return r;
}
