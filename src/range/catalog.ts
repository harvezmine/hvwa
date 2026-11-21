// src/range/catalog.ts — the range's read pages and hints (portal mode): the catalog (/), a lab's page (/labs/:id), a
// paid hint unlock, and the leaderboard. Everything is the signed-in user's (src/range/progress.ts).
import type { Request, Response, Router } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, sendPage } from '../core/render.js';
import { parseTier } from '../core/hints.js';
import { clampLevel, FLAG_LEVELS, LEVELS, levelRank, type Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import { DIFFICULTIES, labPoints, type Difficulty, type LabEntry } from '../lab-registry.js';
import { panelFor } from './panel.js';
import { leaderboard, rangeScore, rangeSolvesOf, rangeUnlockedTiers, unlockRangeHint, type Best } from './progress.js';
import type { RangeContext } from './types.js';

export const rangeViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
export const rangeView = (name: string) => join(rangeViewsDir, `${name}.ejs`);

export interface RangeUser { readonly userId: number; readonly username: string; readonly role: 'player' | 'admin' }

/** The signed-in user (the login gate runs before every range route). */
export function userOf(res: Response): RangeUser {
  const a = res.locals.platformAuth;
  if (!a?.signedIn || a.userId === undefined || a.user === undefined) throw new Error('range: no signed-in user (is the login gate mounted?)');
  return { userId: a.userId, username: a.user, role: a.role === 'admin' ? 'admin' : 'player' };
}

export const isHtmx = (req: Request) => req.get('HX-Request') === 'true';
const isDifficulty = (x: unknown): x is Difficulty => typeof x === 'string' && (DIFFICULTIES as readonly string[]).includes(x);

/** Solved per level, counted like the standalone portal: a scored level ranked at or below the best solved one. */
function levelSolved(level: Level, best: Best | undefined): boolean {
  return level !== 'divine' && best !== undefined && levelRank(level) <= levelRank(best.level);
}

export function labCard(lab: LabEntry, best: Best | undefined, lang: Lang, t: (key: string) => string) {
  return {
    id: lab.id, app: lab.app, title: lab.title[lang], category: lab.category, difficulty: lab.difficulty,
    difficultyLabel: t(`range.difficulty.${lab.difficulty}`), scenario: lab.scenario[lang], href: `/labs/${lab.id}`,
    solved: best !== undefined, best: best?.level,
    levels: LEVELS.filter((l) => lab.levels.includes(l)).map((l) => ({ id: l, solved: levelSolved(l, best) })),
  };
}

function unlockedHintHtml(tier: number, text: string, t: (key: string) => string): string {
  return `<details class="accordion hint" open><summary><span class="hint-name">${escapeHtml(t('challenge.hint_tier'))} ${tier}</span>`
    + `<span class="badge badge-ok">${escapeHtml(t('challenge.hint_unlocked'))}</span></summary>`
    + `<div class="accordion-body"><p class="hint-text" data-tier="${tier}">${escapeHtml(text)}</p></div></details>`;
}

export function catalogRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth } = ctx;

  router.get('/', async (req, res) => {
    const { userId } = userOf(res);
    const t = res.locals.t;
    const solves = rangeSolvesOf(db, userId);
    const categories = [...new Set(registry.labs.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
    const category = typeof req.query.category === 'string' && categories.includes(req.query.category) ? req.query.category : '';
    const difficulty = isDifficulty(req.query.difficulty) ? req.query.difficulty : '';
    const show = req.query.show === 'todo' || req.query.show === 'done' ? req.query.show : 'all';
    const cards = registry.labs.map((lab) => labCard(lab, solves.get(lab.id), req.lang, t)).filter((c) =>
      (category === '' || c.category === category) && (difficulty === '' || c.difficulty === difficulty)
      && (show === 'all' || (show === 'done') === c.solved));
    await sendPage(res, rangeView('catalog'), {
      pageTitle: t('range.catalog_title'), cards, categories, difficulties: DIFFICULTIES, filter: { category, difficulty, show },
      score: rangeScore(db, userId), solved: registry.labs.filter((l) => solves.has(l.id)).length, total: registry.labs.length,
    });
  });

  router.get('/labs/:id', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    const { userId } = userOf(res);
    const t = res.locals.t;
    const best = rangeSolvesOf(db, userId).get(lab.id);
    const currentLevel = clampLevel(req.level, lab.levels);
    const unlocked = new Set(rangeUnlockedTiers(db, userId, lab.id));
    await sendPage(res, rangeView('lab'), {
      pageTitle: `${lab.app} — ${lab.title[req.lang]}`,
      lab: { ...labCard(lab, best, req.lang, t), briefing: lab.briefing[req.lang] },
      best, currentLevel, csrf: auth.csrfFor(req),
      flash: req.query.r === 'wrong' ? 'wrong' : req.query.r === 'solved' && best ? 'solved' : '',
      panel: panelFor(ctx, req, res, lab, currentLevel, req.query.r === 'full' ? 'full' : undefined),
      levels: LEVELS.filter((l) => lab.levels.includes(l)).map((l) => ({
        id: l, scored: FLAG_LEVELS.includes(l), points: labPoints(lab, l), solved: levelSolved(l, best),
        current: l === currentLevel, href: `/labs/${lab.id}?level=${l}`,
      })),
      // A locked hint's text never reaches the view: only what was paid for is rendered.
      hints: [...lab.hints].sort((a, b) => a.id - b.id)
        .map((h) => ({ id: h.id, cost: h.cost, unlocked: unlocked.has(h.id), text: unlocked.has(h.id) ? h.text[req.lang] : '' })),
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: lab.app }],
    });
  });

  router.post('/labs/:id/hint', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const tier = parseTier(req.body?.tier);
    const result = tier === undefined ? undefined : unlockRangeHint(db, userOf(res).userId, lab, tier, ctx.now());
    if (!result?.ok) {
      if (isHtmx(req)) {
        res.status(400).type('html')
          .send(`<p class="result result-bad" role="alert" data-error="tier">${escapeHtml(res.locals.t('challenge.err_unknown_tier'))}</p>`);
        return;
      }
      res.redirect(303, `/labs/${lab.id}`);
      return;
    }
    if (isHtmx(req)) { res.type('html').send(unlockedHintHtml(result.hint.id, result.hint.text[req.lang], res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}#hint-${result.hint.id}`);
  });

  router.get('/leaderboard', async (req, res) => {
    const t = res.locals.t;
    await sendPage(res, rangeView('leaderboard'), {
      pageTitle: t('leaderboard.title'), rows: leaderboard(db, 100), me: userOf(res).userId,
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: t('leaderboard.title') }],
    });
  });
}
