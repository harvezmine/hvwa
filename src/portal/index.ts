// src/portal/index.ts
import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allChallenges, getChallenge, type Challenge } from '../core/registry.js';
import { scoreFor, progress, bestSolve } from '../core/scoreboard.js';
import { unlockedTiers } from '../core/hints.js';
import { isLevel, levelRank, FLAG_LEVELS, LEVELS, type Level } from '../core/levels.js';
import { levelSource } from '../core/source.js';
import { challengePath } from '../core/mount.js';
import { sendPage, diffView, escapeHtml } from '../core/render.js';
import { submitFlag } from '../core/checker.js';
import { unlockHint, parseTier } from '../core/hints.js';

/** The portal's own EJS views (the shared layout lives in core/views). */
export const portalViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(portalViewsDir, `${name}.ejs`);

// One-shot result of a player action, shown on the challenge page. Only these
// keys are ever rendered; `lvl` must be a real level and `g` a small integer.
const FLASH_KEYS = ['new_best', 'already', 'lower', 'wrong', 'err_invalid_tier', 'err_unknown_tier'] as const;
type FlashKey = (typeof FLASH_KEYS)[number];
interface Flash { key: FlashKey; level?: Level; gained?: number }
type Translate = (key: string) => string;

const isHtmx = (req: Request): boolean => req.get('HX-Request') === 'true';

function flashQuery(f: Flash): string {
  const q = new URLSearchParams({ r: f.key });
  if (f.level) q.set('lvl', f.level);
  if (f.gained !== undefined) q.set('g', String(f.gained));
  return `?${q.toString()}`;
}

function flashFrom(query: Request['query']): Flash | undefined {
  const key = FLASH_KEYS.find((k) => k === query.r);
  if (!key) return undefined;
  const lvl = isLevel(query.lvl) ? query.lvl : undefined;
  const g = typeof query.g === 'string' && /^\d{1,6}$/.test(query.g) ? Number(query.g) : undefined;
  return { key, level: lvl, gained: g };
}

function flashHtml(f: Flash, t: Translate): string {
  if (f.key === 'wrong') {
    return `<p class="result result-bad" data-solved="false" data-result="wrong" role="status">${escapeHtml(t('challenge.result_bad'))}</p>`;
  }
  if (f.key === 'err_invalid_tier' || f.key === 'err_unknown_tier') {
    return `<p class="result result-bad" data-error="${f.key}" role="alert">${escapeHtml(t(`challenge.${f.key}`))}</p>`;
  }
  const lvl = f.level ? t(`level.${f.level}`) : '';
  const msg = f.key === 'new_best'
    ? `${t('challenge.result_new_best')} ${lvl}${f.gained === undefined ? '' : ` (+${f.gained} ${t('challenge.points')})`}`
    : `${t(`challenge.result_${f.key}`)} ${lvl}`;
  return `<p class="result result-ok" data-solved="true" data-result="${f.key}" role="status">${escapeHtml(msg)}</p>`;
}

/** Lowest implemented exploitable level's source vs Divine's; undefined if either is unavailable. */
function diffPair(c: Challenge): { vuln: string; secure: string; level: Level } | undefined {
  const low = LEVELS.find((l) => l !== 'divine' && c.levels.includes(l));
  if (!low || !c.levels.includes('divine')) return undefined;
  const vuln = levelSource(c, low);
  const secure = levelSource(c, 'divine');
  return vuln === undefined || secure === undefined ? undefined : { vuln, secure, level: low };
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
    const bestRank = best ? levelRank(best.level) : -1;
    // A level counts as solved when its rank <= the best solved level's rank.
    // One tab per implemented level. Divine is the unscored secure reference: no solved state.
    const levels = LEVELS.filter((l) => c.levels.includes(l)).map((l) => ({
      id: l, scored: FLAG_LEVELS.includes(l), solved: FLAG_LEVELS.includes(l) && levelRank(l) <= bestRank,
      href: `${challengePath(c)}?level=${l}`,
    }));
    const unlocked = new Set(unlockedTiers(db, req.sessionId, c.id));
    const hints = [...c.hints].sort((a, b) => a.id - b.id)
      .map((h) => ({ id: h.id, cost: h.cost, unlocked: unlocked.has(h.id), text: h.text[req.lang] }));
    const sources = LEVELS.filter((l) => c.levels.includes(l) && levelSource(c, l) !== undefined);
    await sendPage(res, view('challenge'), {
      title: c.title[req.lang], c, levels, hints, sources, hasDiff: diffPair(c) !== undefined,
      labPath: challengePath(c), flash: flashFrom(req.query),
      flashHtml: (f: Flash) => flashHtml(f, res.locals.t),
    });
  });

  // Player actions. htmx (HX-Request) gets an escaped fragment (always 200, errors
  // included); plain form posts get a 303 back to the page with a one-shot result
  // from a closed set of keys. Neither ever echoes the submitted text.
  r.post('/c/:id/submit', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    if (!c) { next(); return; }
    const answer = typeof req.body?.submission === 'string' ? req.body.submission : '';
    const result = await submitFlag(db, req.sessionId, c.id, answer);
    const view: Flash = result.status === 'wrong' || result.status === 'unknown_challenge'
      ? { key: 'wrong' }
      : result.status === 'new_best'
        ? { key: 'new_best', level: result.level, gained: result.gained }
        : result.level === result.best.level ? { key: 'already', level: result.level } : { key: 'lower', level: result.best.level };
    if (isHtmx(req)) { res.type('html').send(flashHtml(view, res.locals.t)); return; }
    res.redirect(303, `/c/${c.id}${flashQuery(view)}`);
  });

  r.post('/c/:id/hint', (req, res, next) => {
    const c = getChallenge(req.params.id);
    if (!c) { next(); return; }
    const tier = parseTier(req.body?.tier);
    const result = tier === undefined ? undefined : unlockHint(db, req.sessionId, c.id, tier);
    if (result?.ok) {
      if (isHtmx(req)) {
        res.type('html').send(`<p class="hint-text" data-tier="${result.hint.id}">${escapeHtml(result.hint.text[req.lang])}</p>`);
        return;
      }
      res.redirect(303, `/c/${c.id}`);
      return;
    }
    const view: Flash = { key: tier === undefined ? 'err_invalid_tier' : 'err_unknown_tier' };
    if (isHtmx(req)) { res.type('html').send(flashHtml(view, res.locals.t)); return; }
    res.redirect(303, `/c/${c.id}${flashQuery(view)}`);
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
      title: `${c.id} — ${res.locals.t('challenge.diff_title')}`, c, level: undefined, src: undefined,
      diff: diffView(pair.vuln, pair.secure, req.lang, pair.level),
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
