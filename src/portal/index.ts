// src/portal/index.ts
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allChallenges, getChallenge, type Challenge } from '../core/registry.js';
import { scoreFor, progress, bestSolve } from '../core/scoreboard.js';
import { unlockedTiers } from '../core/hints.js';
import { isLevel, levelRank, FLAG_LEVELS, LEVELS } from '../core/levels.js';
import { levelSource } from '../core/source.js';
import { challengePath } from '../core/mount.js';
import { sendPage, diffView } from '../core/render.js';

/** The portal's own EJS views (the shared layout lives in core/views). */
export const portalViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(portalViewsDir, `${name}.ejs`);

/** Lowest implemented exploitable level's source vs Divine's; undefined if either is unavailable. */
function diffPair(c: Challenge): { vuln: string; secure: string } | undefined {
  const low = LEVELS.find((l) => l !== 'divine' && c.levels.includes(l));
  if (!low || !c.levels.includes('divine')) return undefined;
  const vuln = levelSource(c, low);
  const secure = levelSource(c, 'divine');
  return vuln === undefined || secure === undefined ? undefined : { vuln, secure };
}

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

  // Per-challenge player page. The id only ever selects a registry entry.
  r.get('/c/:id', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    if (!c) { next(); return; }
    const best = bestSolve(db, req.sessionId, c.id);
    const bestRank = best ? levelRank(best.level as (typeof LEVELS)[number]) : -1;
    // A level counts as solved when its rank <= the best solved level's rank.
    const levels = LEVELS.filter((l) => c.levels.includes(l) && FLAG_LEVELS.includes(l)).map((l) => ({
      id: l, solved: levelRank(l) <= bestRank, href: `${challengePath(c)}?level=${l}`,
    }));
    const unlocked = new Set(unlockedTiers(db, req.sessionId, c.id));
    const hints = [...c.hints].sort((a, b) => a.id - b.id)
      .map((h) => ({ id: h.id, cost: h.cost, unlocked: unlocked.has(h.id), text: h.text[req.lang] }));
    const sources = LEVELS.filter((l) => c.levels.includes(l) && levelSource(c, l) !== undefined);
    await sendPage(res, view('challenge'), {
      title: c.title[req.lang], c, levels, hints, sources, hasDiff: diffPair(c) !== undefined,
      labPath: challengePath(c),
    });
  });

  r.get('/c/:id/source/:level', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    const level = req.params.level;
    const src = c && isLevel(level) ? levelSource(c, level) : undefined;
    if (!c || !isLevel(level) || src === undefined) { next(); return; }
    await sendPage(res, view('source'), {
      title: `${c.id} — ${res.locals.t(`level.${level}`)}`, c, level, src, diff: undefined,
    });
  });

  r.get('/c/:id/diff', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    const pair = c ? diffPair(c) : undefined;
    if (!c || !pair) { next(); return; }
    await sendPage(res, view('source'), {
      title: `${c.id} — diff`, c, level: undefined, src: undefined,
      diff: diffView(pair.vuln, pair.secure, req.lang),
    });
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
