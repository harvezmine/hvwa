// src/range/catalog.ts — the range's read pages and hints (portal mode): the catalog (/), a lab's page (/labs/:id), a
// paid hint unlock, and the leaderboard. Everything is the signed-in user's (src/range/progress.ts).
import type { Router } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, sendPage } from '../core/render.js';
import { parseTier } from '../core/hints.js';
import { clampLevel, FLAG_LEVELS, LEVELS, levelRank, type Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import { DIFFICULTIES, TRACKS, labPoints, type Difficulty, type LabEntry } from '../lab-registry.js';
import { MY_LAB_RECENT_MS, panelFor, tierLabel } from './panel.js';
import { leaderboard, rangeScore, rangeSolvesOf, rangeUnlockedTiers, unlockRangeHint, type Best, type LeaderRow } from './progress.js';
import { nextRank, pointsToNext, rankFor, type RankLadder } from './rank.js';
import { labMode, labModes, type LabMode } from './modes.js';
import { teamLeaderboard, teamOfUser, type TeamLeaderRow } from './teams.js';
import { isActiveState } from './store.js';
import { avatarOf, avatarsByUser, DEFAULT_AVATAR } from './avatar.js';
import { counselRoute, SCROLLS, scrollBag, scrollFor, takeStarterNotice } from './shop.js';
import type { RangeContext } from './types.js';
import { isHtmx, userOf, type RangeUser } from './user.js';

export { isHtmx, userOf, type RangeUser };

export const rangeViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
export const rangeView = (name: string) => join(rangeViewsDir, `${name}.ejs`);

const isDifficulty = (x: unknown): x is Difficulty => typeof x === 'string' && (DIFFICULTIES as readonly string[]).includes(x);

/** Solved per level, counted like the standalone portal: a scored level ranked at or below the best solved one. */
function levelSolved(level: Level, best: Best | undefined): boolean {
  return level !== 'divine' && best !== undefined && levelRank(level) <= levelRank(best.level);
}

/** A line illustration per lab identity (themeId); platform mapping, no manifest change. */
const THEME_ICONS: Readonly<Record<string, string>> = Object.freeze({
  'mercy-clinic': 'i-ill-clinic', courier: 'i-ill-courier', beacon: 'i-ill-beacon', postcard: 'i-ill-postcard',
  binanse: 'i-ill-binanse', camelot: 'i-ill-camelot',
});
const themeIcon = (themeId: string) => THEME_ICONS[themeId.replace(/^theme-/, '')] ?? 'i-flask';

/** A compact UTC stamp for the team leaderboard's last-solve column (deterministic, no locale/tz). */
const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** The monochrome seal mark for a difficulty: Roman numerals, so the adventurer rank (E–S) is the only letter rank. */
const DIFFICULTY_MARK: Readonly<Record<Difficulty, string>> = Object.freeze({ easy: 'I', medium: 'II', hard: 'III', expert: 'IV' });

export function labCard(lab: LabEntry, best: Best | undefined, lang: Lang, t: (key: string) => string, mode: LabMode = 'individual') {
  const levels = LEVELS.filter((l) => lab.levels.includes(l));
  const scored = levels.filter((l): l is Level => FLAG_LEVELS.includes(l));
  const bounty = scored.length > 0 ? Math.max(...scored.map((l) => labPoints(lab, l))) : 0;
  return {
    id: lab.id, app: lab.app, title: lab.title[lang], category: lab.category, track: lab.track, difficulty: lab.difficulty,
    difficultyLabel: t(`range.difficulty.${lab.difficulty}`), difficultyMark: DIFFICULTY_MARK[lab.difficulty],
    threat: DIFFICULTIES.indexOf(lab.difficulty) + 1,
    scenario: lab.scenario[lang], href: `/labs/${lab.id}`,
    solved: best !== undefined, best: best?.level, bestLabel: best ? tierLabel(t, best.level) : '',
    themeId: lab.themeId, icon: themeIcon(lab.themeId), bounty,
    mode,
    levels: levels.map((l) => ({ id: l, label: tierLabel(t, l), solved: levelSolved(l, best), points: labPoints(lab, l) })),
  };
}

/** The guild card's rank: letter, title, plate metal and the way to the next one (rank.ts; derived, never stored). */
function rankView(score: number, ladder: RankLadder, t: (key: string) => string) {
  const step = rankFor(score, ladder);
  const next = nextRank(score, ladder);
  return {
    letter: step.letter, name: t(`rank.name.${step.letter.toLowerCase()}`), plate: t(`rank.plate.${step.letter.toLowerCase()}`),
    points: score, nextLetter: next?.letter ?? '', nextName: next ? t(`rank.plate.${next.letter.toLowerCase()}`) : '',
    nextMinPoints: next?.minPoints ?? score, toNext: pointsToNext(score, ladder), maxed: next === undefined,
  };
}

/** The "Continue your lab" hero: the user's active (or recently ended) instance, if any. */
function continueLabFor(ctx: RangeContext, userId: number, lang: Lang, t: (key: string) => string) {
  const latest = ctx.lifecycle.store.latestForUser(userId);
  if (!latest) return undefined;
  const now = ctx.now();
  const recent = latest.endedAt !== null && now - latest.endedAt < MY_LAB_RECENT_MS;
  if (!isActiveState(latest.state) && !recent) return undefined;
  const lab = ctx.registry.get(latest.labId);
  if (!lab) return undefined;
  const stopKey = `range.stopped.${latest.reason ?? ''}`;
  const stateLabel = latest.state === 'stopped'
    ? (t(stopKey) === stopKey ? t('range.state.stopped') : t(stopKey)) : t(`range.state.${latest.state}`);
  return {
    href: `/labs/${latest.labId}?level=${latest.level}`, app: lab.app, title: lab.title[lang], themeId: lab.themeId,
    icon: themeIcon(lab.themeId), state: latest.state, stateLabel,
    minutesLeft: latest.state === 'running' ? Math.max(0, Math.ceil(((latest.expiresAt ?? now) - now) / 60_000)) : 0,
  };
}

/** The Guildmaster's counsel once heard (an htmx swap into #hint-<tier>); it carries the toast and the line he speaks. */
function counselHtml(tier: number, text: string, t: (key: string) => string): string {
  const scroll = scrollFor(tier);
  const kind = scroll?.kind ?? '';
  const scrollName = scroll ? t(`scroll.${scroll.kind}.name`) : '';
  const title = t('gm.toast_title');
  const message = t('gm.toast').replace('{scroll}', scrollName);
  return `<div class="counsel-heard" data-kind="${kind}" data-counsel-say data-toast="unlocked" data-toast-variant="success" data-toast-title="${escapeHtml(title)}" data-toast-message="${escapeHtml(message)}" data-level="${tier}">`
    + `<span class="scroll-icon is-open" data-kind="${kind}" aria-hidden="true"></span>`
    + `<p class="counsel-tier">${escapeHtml(t('gm.counsel').replace('{n}', String(tier)))} · ${escapeHtml(scrollName)} <span class="badge badge-ok">${escapeHtml(t('gm.heard'))}</span></p>`
    + `<p class="hint-text" data-tier="${tier}">${escapeHtml(text)}</p></div>`;
}

export function catalogRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth } = ctx;

  router.get('/', async (req, res) => {
    const { userId } = userOf(res);
    const t = res.locals.t;
    const solves = rangeSolvesOf(db, userId);
    const modes = labModes(db);
    const categories = [...new Set(registry.labs.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
    const category = typeof req.query.category === 'string' && categories.includes(req.query.category) ? req.query.category : '';
    const difficulty = isDifficulty(req.query.difficulty) ? req.query.difficulty : '';
    const show = req.query.show === 'todo' || req.query.show === 'done' ? req.query.show : 'all';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const needle = q.toLowerCase();
    const sort = req.query.sort === 'difficulty' || req.query.sort === 'solved' ? req.query.sort : 'app';
    const byApp = (a: { app: string }, b: { app: string }) => a.app.localeCompare(b.app);
    const cards = registry.labs.map((lab) => labCard(lab, solves.get(lab.id), req.lang, t, modes.get(lab.id))).filter((c) =>
      (category === '' || c.category === category) && (difficulty === '' || c.difficulty === difficulty)
      && (show === 'all' || (show === 'done') === c.solved)
      && (needle === '' || [c.app, c.title, c.scenario, c.category].some((s) => s.toLowerCase().includes(needle))));
    cards.sort(sort === 'difficulty'
      ? (a, b) => DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty) || byApp(a, b)
      : sort === 'solved' ? (a, b) => Number(b.solved) - Number(a.solved) || byApp(a, b) : byApp);
    const score = rangeScore(db, userId);
    // One board per guild track (a slide in the board carousel); a track with no lab yet is shown as "soon".
    const boards = TRACKS.map((track) => {
      const all = registry.labs.filter((l) => l.track === track);
      return {
        id: track, name: t(`range.track.${track}`), sub: t(`range.track_sub.${track}`),
        total: all.length, done: all.filter((l) => solves.has(l.id)).length, cards: cards.filter((c) => c.track === track),
      };
    });
    const needsAvatar = avatarOf(db, userId) === undefined && userOf(res).role === 'player';
    const gift = needsAvatar || isHtmx(req) ? undefined : takeStarterNotice(db, userId, ctx.now());
    await sendPage(res, rangeView('catalog'), {
      pageTitle: t('range.catalog_title'), cards, boards, categories, difficulties: DIFFICULTIES,
      filter: { category, difficulty, show, q, sort }, filtered: category !== '' || difficulty !== '' || show !== 'all' || q !== '',
      score, solved: registry.labs.filter((l) => solves.has(l.id)).length, total: registry.labs.length,
      rank: rankView(score, ctx.ranks, t), username: res.locals.platformAuth?.user ?? '',
      continueLab: continueLabFor(ctx, userId, req.lang, t),
      // No adventurer yet: Mira invites the player to make one (or skip and keep the default).
      avatar: avatarOf(db, userId) ?? DEFAULT_AVATAR, needsAvatar,
      // Once the adventurer is made, Mira hands over the starter purse in a popup, shown once (then the tour).
      gift: gift === undefined ? undefined : { amount: gift, scroll: t(`scroll.${SCROLLS[1].kind}.name`), before: Math.max(0, score - gift) },
      madeAvatar: req.query.made === '1', csrf: auth.csrfFor(req),
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
    const mode = labMode(db, lab.id);
    const bag = scrollBag(db, userId);
    await sendPage(res, rangeView('lab'), {
      pageTitle: `${lab.app} — ${lab.title[req.lang]}`,
      lab: { ...labCard(lab, best, req.lang, t, mode), briefing: lab.briefing[req.lang] },
      best, currentLevel, csrf: auth.csrfFor(req),
      flash: req.query.r === 'wrong' ? 'wrong' : req.query.r === 'decoy' ? 'decoy' : req.query.r === 'solved' && best ? 'solved' : '',
      panel: panelFor(ctx, req, res, lab, currentLevel, req.query.r === 'full' ? 'full' : undefined),
      levels: LEVELS.filter((l) => lab.levels.includes(l)).map((l) => ({
        id: l, label: tierLabel(t, l, true), scored: FLAG_LEVELS.includes(l), points: labPoints(lab, l), solved: levelSolved(l, best),
        current: l === currentLevel, href: `/labs/${lab.id}?level=${l}`,
      })),
      // A locked counsel's text never reaches the view: only what a scroll paid for is rendered.
      hints: [...lab.hints].sort((a, b) => a.id - b.id).map((h) => {
        const scroll = scrollFor(h.id)!;
        return { id: h.id, kind: scroll.kind, have: bag[scroll.kind], unlocked: unlocked.has(h.id), text: unlocked.has(h.id) ? h.text[req.lang] : '' };
      }),
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: lab.app }],
    });
  });

  counselRoute(router, ctx, counselHtml);

  router.get('/leaderboard', async (req, res) => {
    const t = res.locals.t;
    const me = userOf(res).userId;
    const board = req.query.board === 'teams' ? 'teams' : 'individual';
    const crumbs = [{ label: t('nav.labs'), href: '/' }, { label: t('leaderboard.title') }];
    if (board === 'teams') {
      const rankOf = (r: TeamLeaderRow) => ({ ...r, lastLabel: r.lastSolveAt === 0 ? '' : utcStamp(r.lastSolveAt) });
      const rows = teamLeaderboard(db, 100).map(rankOf);
      const myTeamId = teamOfUser(db, me)?.id;
      const viewer = rows.find((r) => r.teamId === myTeamId);
      // The viewer's team, even beyond the top 100: pinned below when not already in the top three.
      const beyond = myTeamId === undefined ? undefined : teamLeaderboard(db, 100_000).find((r) => r.teamId === myTeamId);
      const teamPinned = viewer !== undefined && viewer.rank > 3 ? viewer : (beyond === undefined ? undefined : rankOf(beyond));
      await sendPage(res, rangeView('leaderboard'), {
        pageTitle: t('leaderboard.title'), board, crumbs, myTeamId,
        rows: [], me, viewer: undefined, pinned: undefined, standing: undefined,
        teamRows: rows, teamViewer: viewer, teamPinned,
      });
      return;
    }
    const avatars = avatarsByUser(db);
    const rankOf = (r: LeaderRow) => ({ ...r, rankLetter: rankFor(r.score, ctx.ranks).letter, avatar: avatars.get(r.userId) ?? DEFAULT_AVATAR });
    const rows = leaderboard(db, 100).map(rankOf);
    // The viewer's own row, even beyond the top 100: pinned below the table when it is not already in the top three.
    const everyone = leaderboard(db, 100_000);
    const beyond = everyone.find((r) => r.userId === me);
    const viewer = rows.find((r) => r.userId === me) ?? (beyond === undefined ? undefined : rankOf(beyond));
    const pinned = viewer !== undefined && viewer.rank > 3 ? viewer : undefined;
    // Where the viewer stands (a relative view, so a long board still shows a reachable next target).
    const ahead = viewer === undefined ? undefined : everyone.find((r) => r.rank === viewer.rank - 1);
    const standing = viewer === undefined ? undefined : {
      pct: Math.max(1, Math.ceil((viewer.rank / everyone.length) * 100)), atTop: viewer.rank === 1,
      gap: ahead === undefined ? undefined : { points: ahead.score - viewer.score + 1, name: ahead.username },
    };
    await sendPage(res, rangeView('leaderboard'), {
      pageTitle: t('leaderboard.title'), board, rows, me, viewer, pinned, crumbs, standing,
      teamRows: [], myTeamId: undefined, teamViewer: undefined, teamPinned: undefined,
    });
  });
}
