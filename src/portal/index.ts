// src/portal/index.ts
import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY, type Challenge, type ChallengeSet } from '../core/registry.js';
import { scoreFor, progress, bestSolve, solvesOf } from '../core/scoreboard.js';
import { unlockedTiers, hintCost } from '../core/hints.js';
import { isLevel, levelRank, clampLevel, pointsForLevel, FLAG_LEVELS, LEVELS, LEVEL_MULTIPLIER, type Level } from '../core/levels.js';
import { districtName, districtBlurb, t as translate, type Lang } from '../core/i18n.js';
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
// level = the level this result is about; best = the stored best (lower only);
// gained is set only on the htmx path, where it is computed in the same request.
interface Flash { key: FlashKey; level?: Level; best?: Level; gained?: number }
type Translate = (key: string) => string;

const isHtmx = (req: Request): boolean => req.get('HX-Request') === 'true';

function flashQuery(f: Flash): string {
  const q = new URLSearchParams({ r: f.key });
  if (f.level) q.set('lvl', f.level);
  return `?${q.toString()}`;
}

/**
 * Rebuild a result from a redirect link. Never trusted: new_best/already/lower
 * need a scored `lvl` and are shown only when consistent with this session's
 * stored best (the message data comes from the DB, not the URL).
 */
function flashFrom(query: Request['query'], best: { level: Level } | undefined): Flash | undefined {
  const key = FLASH_KEYS.find((k) => k === query.r);
  if (!key) return undefined;
  if (key === 'wrong' || key === 'err_invalid_tier' || key === 'err_unknown_tier') return { key };
  const lvl = isLevel(query.lvl) && FLAG_LEVELS.includes(query.lvl) ? query.lvl : undefined;
  if (!lvl || !best) return undefined;
  if (key === 'lower') return levelRank(best.level) > levelRank(lvl) ? { key, level: lvl, best: best.level } : undefined;
  return best.level === lvl ? { key, level: lvl } : undefined;
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
    : f.key === 'lower'
      ? `${t('challenge.result_lower')} ${f.best ? t(`level.${f.best}`) : ''}`
      : `${t(`challenge.result_${f.key}`)} ${lvl}`;
  return `<p class="result result-ok" data-solved="true" data-result="${f.key}" role="status">${escapeHtml(msg)}</p>`;
}

/** An unlocked hint tier as the challenge page shows it (also the htmx swap after an unlock): escaped text. */
function unlockedHintHtml(tier: number, text: string, t: Translate): string {
  return `<details class="accordion hint" open><summary><span class="hint-name">${escapeHtml(t('challenge.hint_tier'))} ${tier}</span>`
    + `<span class="badge badge-ok">${escapeHtml(t('challenge.hint_unlocked'))}</span></summary>`
    + `<div class="accordion-body"><p class="hint-text" data-tier="${tier}">${escapeHtml(text)}</p></div></details>`;
}

/** Lowest implemented exploitable level's source vs Divine's; undefined if either is unavailable. */
function diffPair(c: Challenge): { vuln: string; secure: string; level: Level } | undefined {
  const low = LEVELS.find((l) => l !== 'divine' && c.levels.includes(l));
  if (!low || !c.levels.includes('divine')) return undefined;
  const vuln = levelSource(c, low);
  const secure = levelSource(c, 'divine');
  return vuln === undefined || secure === undefined ? undefined : { vuln, secure, level: low };
}

// Presentation only: the portal's district order and icons (core/views/icons.ejs). Unknown districts follow, by id.
const DISTRICT_ORDER = ['gatekeeper', 'relic-market', 'scriptorium', 'forum-of-pilgrims'];
const DISTRICT_ICONS: Readonly<Record<string, string>> = {
  gatekeeper: 'shield', 'relic-market': 'bag', scriptorium: 'scroll', 'forum-of-pilgrims': 'messages',
};
const districtRank = (id: string) => { const i = DISTRICT_ORDER.indexOf(id); return i === -1 ? DISTRICT_ORDER.length : i; };
const byId = (a: Challenge, b: Challenge) => a.id.localeCompare(b.id, undefined, { numeric: true });
/** The OWASP Top 10 entry of a challenge's mappings ("A05:2025"), if it has one. */
const owaspOf = (c: Challenge) => c.maps.find((m) => /^A\d{2}:\d{4}$/.test(m));

type Solves = ReturnType<typeof solvesOf>;

/** The challenges grouped by district, in portal order, each list by id, with this session's solves. */
function districtsOf(all: readonly Challenge[], solves: Solves, lang: Lang) {
  const byDistrict = new Map<string, Challenge[]>();
  for (const c of all) byDistrict.set(c.district, [...(byDistrict.get(c.district) ?? []), c]);
  return [...byDistrict.entries()]
    .sort((a, b) => districtRank(a[0]) - districtRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([id, list]) => {
      const name = districtName(id, lang);
      const challenges = [...list].sort(byId).map((c) => {
        const best = solves.get(c.id);
        return {
          id: c.id, title: c.title[lang], summary: c.summary[lang], owasp: owaspOf(c), districtName: name,
          levels: LEVELS.filter((l) => c.levels.includes(l)),
          solved: best !== undefined, best: best?.level, points: best?.points ?? 0,
        };
      });
      return {
        id, name, desc: districtBlurb(id, lang), icon: DISTRICT_ICONS[id] ?? 'landmark', href: `/d/${id}`,
        challenges, total: challenges.length, solved: challenges.filter((c) => c.solved).length,
        points: challenges.reduce((n, c) => n + c.points, 0),
      };
    });
}

/** Home > District > <id> > <page>: the breadcrumb of the source and diff pages. */
function sourceCrumbs(c: Challenge, lang: Lang, label: string) {
  return [
    { label: translate('nav.home', lang), href: '/' },
    { label: districtName(c.district, lang), href: `/d/${c.district}` },
    { label: c.id, href: `/c/${c.id}` },
    { label },
  ];
}

// Reads only the registry (through `challenges`, the app's edition); never imports a challenge directly.
// A challenge outside `challenges` is unknown on every page (404) and absent from every list and count.
// lang / t come from res.locals (langMiddleware).
export function portalRouter(db: DatabaseSync, challenges: ChallengeSet = REGISTRY): Router {
  const r = Router();
  const getChallenge = (id: string) => challenges.get(id);

  r.get('/', async (req, res) => {
    const districts = districtsOf(challenges.all(), solvesOf(db, req.sessionId), req.lang);
    const total = districts.reduce((n, d) => n + d.total, 0);
    const solved = districts.reduce((n, d) => n + d.solved, 0);
    // "Continue": the first unsolved challenge, in portal order.
    const nextUp = districts.flatMap((d) => d.challenges).find((c) => !c.solved);
    await sendPage(res, view('index'), {
      pageTitle: res.locals.t('app.title'), districts, total, solved, nextUp,
      score: scoreFor(db, req.sessionId, challenges.only),
    });
  });

  // District page: its challenges as cards; ?show=todo|done filters them (plain links, no JS).
  r.get('/d/:district', async (req, res, next) => {
    const d = districtsOf(challenges.all(), solvesOf(db, req.sessionId), req.lang).find((x) => x.id === req.params.district);
    if (!d) { next(); return; }
    const show = req.query.show === 'todo' || req.query.show === 'done' ? req.query.show : 'all';
    const shown = d.challenges.filter((c) => show === 'all' || (show === 'done') === c.solved);
    await sendPage(res, view('district'), {
      pageTitle: d.name, d, show, shown,
      crumbs: [{ label: res.locals.t('nav.home'), href: '/' }, { label: d.name }],
    });
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
    // The level the lab would open at: the remembered ?level=, clamped exactly as the lab clamps it.
    const current = clampLevel(req.level, c.levels);
    const district = { id: c.district, name: districtName(c.district, req.lang), href: `/d/${c.district}` };
    await sendPage(res, view('challenge'), {
      pageTitle: c.title[req.lang], c, levels, hints, sources, hasDiff: diffPair(c) !== undefined,
      openLabHref: challengePath(c), flash: flashFrom(req.query, best),
      flashHtml: (f: Flash) => flashHtml(f, res.locals.t),
      current, bestLevel: best?.level, district,
      levelPoints: Object.fromEntries(LEVELS.map((l) => [l, pointsForLevel(c.points, l)])),
      crumbs: [{ label: res.locals.t('nav.home'), href: '/' }, { label: district.name, href: district.href }, { label: c.id }],
    });
  });

  // Player actions. htmx (HX-Request) gets an escaped fragment (always 200, errors
  // included); plain form posts get a 303 back to the page with a one-shot result
  // from a closed set of keys. Neither ever echoes the submitted text.
  r.post('/c/:id/submit', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    if (!c) { next(); return; }
    const answer = typeof req.body?.submission === 'string' ? req.body.submission : '';
    const result = await submitFlag(db, req.sessionId, c.id, answer, challenges);
    const view: Flash = result.status === 'wrong' || result.status === 'unknown_challenge'
      ? { key: 'wrong' }
      : result.status === 'new_best'
        ? { key: 'new_best', level: result.level, gained: result.gained }
        : result.level === result.best.level
          ? { key: 'already', level: result.level }
          : { key: 'lower', level: result.level, best: result.best.level };
    if (isHtmx(req)) { res.type('html').send(flashHtml(view, res.locals.t)); return; }
    res.redirect(303, `/c/${c.id}${flashQuery(view)}`);
  });

  r.post('/c/:id/hint', (req, res, next) => {
    const c = getChallenge(req.params.id);
    if (!c) { next(); return; }
    const tier = parseTier(req.body?.tier);
    const result = tier === undefined ? undefined : unlockHint(db, req.sessionId, c.id, tier, challenges);
    if (result?.ok) {
      if (isHtmx(req)) {
        res.type('html').send(unlockedHintHtml(result.hint.id, result.hint.text[req.lang], res.locals.t));
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
      pageTitle: `${c.id} — ${res.locals.t(`level.${level}`)}`, c, srcLevel: level, src, diff: undefined,
      crumbs: sourceCrumbs(c, req.lang, res.locals.t('challenge.source')),
    });
  });

  r.get('/c/:id/diff', async (req, res, next) => {
    const c = getChallenge(req.params.id);
    const pair = c ? diffPair(c) : undefined;
    if (!c || !pair) { next(); return; }
    await sendPage(res, view('source'), {
      pageTitle: `${c.id} — ${res.locals.t('challenge.diff_title')}`, c, srcLevel: undefined, src: undefined,
      diff: diffView(pair.vuln, pair.secure, req.lang, pair.level),
      crumbs: sourceCrumbs(c, req.lang, res.locals.t('challenge.diff')),
    });
  });

  r.get('/scoreboard', async (req, res) => {
    const sid = req.sessionId;
    const districts = districtsOf(challenges.all(), solvesOf(db, sid), req.lang);
    const all = districts.flatMap((d) => d.challenges);
    // Per level: how many challenges have it as their best solve (Divine is never scored).
    const byLevel = FLAG_LEVELS.map((l) => ({ id: l, multiplier: LEVEL_MULTIPLIER[l], count: all.filter((c) => c.best === l).length }));
    await sendPage(res, view('scoreboard'), {
      pageTitle: res.locals.t('scoreboard.title'),
      score: scoreFor(db, sid, challenges.only),
      solved: progress(db, sid, challenges.only).solved,
      total: all.length, districts, byLevel, hintCost: hintCost(db, sid, challenges.only),
      crumbs: [{ label: res.locals.t('nav.home'), href: '/' }, { label: res.locals.t('scoreboard.title') }],
    });
  });

  return r;
}
