// src/quest/index.ts — the story quests (portal mode): a visual-novel journal page per quest, played by
// static/quest.js. PLATFORM code. What a player may see is decided here, never in the browser:
//   - a chapter is unlocked when the one before it is done (the prologue always is);
//   - a chapter's scenes, challenge and evidence leave the server only once it is unlocked, and the scenes after its
//     challenge (which give the answer away) only once the player's answer was right;
//   - answers are checked here, normalised (case, spaces, punctuation and leetspeak do not matter), with a small
//     per-player throttle on wrong guesses;
//   - evidence is served from src/quest/<quest>/evidence, as a download, and a challenge's "drop" (a fake archive path
//     such as /im4ges/foren/themepark/13) answers 404 until its chapter is unlocked;
//   - a picture that shows a challenge's answer (a scene step `cg: 'sealed:<name>'`) is not under /static: it is served
//     from src/quest/<quest>/sealed only to a player who has finished that chapter.
// Progress is one row per finished chapter (src/db/quest.sql).
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { escapeHtml, sendPage } from '../core/render.js';
import type { Lang } from '../core/i18n.js';
import type { RangeContext } from '../range/types.js';
import { userOf } from '../range/user.js';
import { avatarOf, DEFAULT_AVATAR } from '../range/avatar.js';
import { localize, type Chapter, type Quest } from './types.js';
import { SILENT_FRIDAY } from './silent-friday/story.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW = join(here, 'views', 'quest.ejs');

export const QUESTS: readonly Quest[] = Object.freeze([SILENT_FRIDAY]);
export const questById = (id: string): Quest | undefined => QUESTS.find((q) => q.id === id);

/** Wrong answers allowed per chapter in a sliding minute before the guild asks the player to slow down. */
export const WRONG_PER_MINUTE = 8;

/** An answer as compared: lower case, leetspeak read as letters, everything but letters and digits dropped. */
export function normalise(answer: string): string {
  const leet: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
  return answer.toLowerCase().replace(/[013457@$]/g, (c) => leet[c] ?? c).replace(/[^a-z0-9]/g, '');
}

export function chaptersDone(db: DatabaseSync, userId: number, questId: string): Set<number> {
  const rows = db.prepare('SELECT chapter FROM quest_progress WHERE user_id = ? AND quest_id = ?').all(userId, questId) as { chapter: number }[];
  return new Set(rows.map((r) => r.chapter));
}

function markDone(db: DatabaseSync, userId: number, questId: string, chapter: number, at: number): void {
  db.prepare('INSERT OR IGNORE INTO quest_progress (user_id, quest_id, chapter, done_at) VALUES (?, ?, ?, ?)').run(userId, questId, chapter, at);
}

export const isUnlocked = (n: number, done: ReadonlySet<number>): boolean => n === 0 || done.has(n - 1);

/** The journal's view of a quest for one player: each chapter done, open or locked. */
export function questStatus(db: DatabaseSync, userId: number, quest: Quest) {
  const done = chaptersDone(db, userId, quest.id);
  const chapters = quest.chapters.map((c) => ({
    n: c.n, state: done.has(c.n) ? 'done' as const : isUnlocked(c.n, done) ? 'open' as const : 'locked' as const,
  }));
  return { done: chapters.filter((c) => c.state === 'done').length, total: quest.chapters.length + quest.upcoming.length, chapters, accepted: done.has(0) };
}

function evidenceDir(quest: Quest): string { return join(here, quest.id, 'evidence'); }

function sendEvidence(res: Response, quest: Quest, file: string, as: string): void {
  res.set('Content-Disposition', `attachment; filename="${as}"`);
  res.type('application/octet-stream');
  res.sendFile(join(evidenceDir(quest), file));
}

function chapterView(quest: Quest, c: Chapter, done: boolean, lang: Lang) {
  const ch = c.challenge;
  return {
    n: c.n, title: localize(c.title, lang), sub: localize(c.sub, lang), done,
    pre: localize(c.pre, lang), recap: localize(c.recap, lang),
    challenge: ch === undefined ? undefined : {
      title: localize(ch.title, lang), brief: localize(ch.brief, lang), placeholder: localize(ch.placeholder, lang),
      evidence: ch.evidence.map((e) => ({ label: localize(e.label, lang), name: e.as, href: `/quests/${quest.id}/evidence/${c.n}/${encodeURIComponent(e.as)}` })),
    },
    post: done && c.post ? localize(c.post, lang) : undefined,
    recapPost: done && c.recapPost ? localize(c.recapPost, lang) : undefined,
  };
}

export function questRoutes(router: Router, ctx: RangeContext): void {
  const { db, auth } = ctx;
  const wrong = new Map<string, number[]>();

  const chapterOf = (quest: Quest, raw: string): Chapter | undefined => {
    const n = /^\d{1,2}$/.test(raw) ? Number(raw) : -1;
    return quest.chapters.find((c) => c.n === n);
  };

  // Everything the stage says in one language: its own words, the cast, the chapter list. The page boots with it, and
  // the stage asks for it again when the player picks another language at the start of a chapter.
  const stageWords = (quest: Quest, userId: number, lang: Lang, t: (key: string) => string) => {
    const status = questStatus(db, userId, quest);
    return {
      lang,
      quest: { id: quest.id, art: quest.art, title: localize(quest.title, lang), reward: quest.reward },
      cast: localize(quest.cast, lang),
      chapters: quest.chapters.map((c, i) => ({
        // A locked chapter keeps its name and picture to itself until the one before it is done.
        n: c.n, title: status.chapters[i]!.state === 'locked' ? '? ? ?' : localize(c.title, lang), sub: localize(c.sub, lang),
        cover: status.chapters[i]!.state === 'locked' ? '' : c.cover, state: status.chapters[i]!.state,
        challenge: c.challenge !== undefined,
      })),
      upcoming: localize(quest.upcoming, lang),
      ui: Object.fromEntries(QUEST_UI.map((k) => [k, t(`quest.${k}`)])),
    };
  };

  router.get('/quests/:quest/stage', (req, res, next) => {
    const quest = questById(req.params.quest);
    if (!quest) { next(); return; }
    res.json(stageWords(quest, userOf(res).userId, req.lang, res.locals.t));
  });

  router.get('/quests/:quest', async (req, res, next) => {
    const quest = questById(req.params.quest);
    if (!quest) { next(); return; }
    const user = userOf(res);
    const t = res.locals.t;
    const lang: Lang = req.lang;
    const status = questStatus(db, user.userId, quest);
    const hero = (avatarOf(db, user.userId) ?? DEFAULT_AVATAR).hero;
    const boot = {
      ...stageWords(quest, user.userId, lang, t),
      csrf: auth.csrfFor(req),
      host: req.get('host') ?? '',
      player: { name: user.username, face: `/static/art/heroes/${hero}-face.webp` },
    };
    await sendPage(res, VIEW, {
      pageTitle: `${localize(quest.title, lang) as string} — ${t('quest.grand')}`,
      quest: {
        id: quest.id, art: quest.art, title: localize(quest.title, lang), tagline: localize(quest.tagline, lang), reward: quest.reward,
        chapters: boot.chapters, upcoming: localize(quest.upcoming, lang), done: status.done, total: status.total,
      },
      bootJson: JSON.stringify(boot).replace(/</g, '\\u003c'),
      crumbs: [{ label: t('nav.labs'), href: '/#board-forensics' }, { label: localize(quest.title, lang) as string }],
    });
  });

  router.get('/quests/:quest/chapter/:n', (req, res, next) => {
    const quest = questById(req.params.quest);
    const c = quest && chapterOf(quest, req.params.n);
    if (!quest || !c) { next(); return; }
    const done = chaptersDone(db, userOf(res).userId, quest.id);
    if (!isUnlocked(c.n, done)) { res.status(404).json({ ok: false, error: 'locked' }); return; }
    res.json(chapterView(quest, c, done.has(c.n), req.lang));
  });

  router.post('/quests/:quest/chapter/:n', (req, res, next) => {
    const quest = questById(req.params.quest);
    const c = quest && chapterOf(quest, req.params.n);
    if (!quest || !c) { next(); return; }
    if (!auth.formOk(req)) { res.status(403).json({ ok: false, error: 'csrf' }); return; }
    const userId = userOf(res).userId;
    const done = chaptersDone(db, userId, quest.id);
    if (!isUnlocked(c.n, done)) { res.status(404).json({ ok: false, error: 'locked' }); return; }
    const lang: Lang = req.lang;
    if (c.challenge === undefined) {
      markDone(db, userId, quest.id, c.n, ctx.now());
      res.json({ ok: true });
      return;
    }
    if (done.has(c.n)) { res.json({ ok: true, post: localize(c.post ?? [], lang), recapPost: c.recapPost ? localize(c.recapPost, lang) : undefined }); return; }
    const key = `${userId}:${quest.id}:${c.n}`;
    const now = ctx.now();
    const recent = (wrong.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= WRONG_PER_MINUTE) { res.status(429).json({ ok: false, error: 'slow' }); return; }
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.slice(0, 200) : '';
    if (normalise(answer) === '' || !c.challenge.answers.includes(normalise(answer))) {
      recent.push(now);
      wrong.set(key, recent);
      res.json({ ok: false, error: 'wrong' });
      return;
    }
    wrong.delete(key);
    markDone(db, userId, quest.id, c.n, now);
    res.json({ ok: true, post: localize(c.post ?? [], lang), recapPost: c.recapPost ? localize(c.recapPost, lang) : undefined });
  });

  router.get('/quests/:quest/evidence/:n/:file', (req, res, next) => {
    const quest = questById(req.params.quest);
    const c = quest && chapterOf(quest, req.params.n);
    const e = c?.challenge?.evidence.find((x) => x.as === req.params.file);
    if (!quest || !c || !e || !isUnlocked(c.n, chaptersDone(db, userOf(res).userId, quest.id))) { next(); return; }
    sendEvidence(res, quest, e.file, e.as);
  });

  router.get('/quests/:quest/sealed/:n/:file', (req, res, next) => {
    const quest = questById(req.params.quest);
    const c = quest && chapterOf(quest, req.params.n);
    const name = /^([a-z0-9-]{1,40})\.webp$/.exec(req.params.file)?.[1];
    const named = c?.post?.some((s) => 'cg' in s && s.cg === `sealed:${name}`) ?? false;
    if (!quest || !c || !name || !named || !chaptersDone(db, userOf(res).userId, quest.id).has(c.n)) { next(); return; }
    res.type('image/webp');
    res.sendFile(join(here, quest.id, 'sealed', `${name}.webp`));
  });

  // A challenge's drop: an "archive" path written on a clue. 404 (as if it did not exist) until the chapter is open.
  for (const quest of QUESTS) {
    for (const c of quest.chapters) {
      const drop = c.challenge?.drop;
      if (!drop) continue;
      const open = (res: Response) => isUnlocked(c.n, chaptersDone(db, userOf(res).userId, quest.id));
      router.get([drop.path, `${drop.path}/`], (req: Request, res: Response, next) => {
        if (!open(res)) { next(); return; }
        if (!req.path.endsWith('/')) { res.redirect(301, `${drop.path}/`); return; }
        const rows = drop.files.map((f) => `<tr><td><a href="${escapeHtml(f.as)}">${escapeHtml(f.as)}</a></td></tr>`).join('');
        res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Index of ${escapeHtml(drop.path)}/</title></head>`
          + `<body><h1>Index of ${escapeHtml(drop.path)}/</h1><table><tr><th>Name</th></tr><tr><td><a href="../">Parent Directory</a></td></tr>${rows}</table>`
          + '<hr><address>Valeria Archive Server</address></body></html>');
      });
      router.get(`${drop.path}/:file`, (req, res, next) => {
        const f = drop.files.find((x) => x.as === req.params.file);
        if (!f || !open(res)) { next(); return; }
        sendEvidence(res, quest, f.file, f.as);
      });
    }
  }
}

/** The stage's own words (i18n quest.<key>), handed to static/quest.js. */
export const QUEST_UI = [
  'begin', 'continue', 'replay', 'locked', 'soon', 'done', 'auto', 'log', 'skip', 'close', 'next', 'submit', 'evidence',
  'wrong', 'slow', 'solved', 'chapter_done', 'back', 'next_chapter', 'answer', 'grand', 'accepted', 'reward', 'tap',
  'left', 'backlog', 'case', 'error', 'confirm_close', 'gold', 'end', 'resume', 'archive_hint', 'checking', 'sound', 'choose', 'found', 'skip_title', 'skip_go', 'skip_stay', 'clue', 'notes',
  'close_title', 'close_go', 'close_stay', 'text', 'hint', 'qte_mash', 'qte_alternate', 'qte_hold', 'qte_timing', 'qte_still', 'qte_dodge', 'qte_again', 'qte_space', 'qte_touch', 'qte_end', 'qte_retry',
] as const;
