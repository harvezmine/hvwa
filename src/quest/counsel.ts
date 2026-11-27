// src/quest/counsel.ts — the Guildmaster's counsel on a story quest's case (portal mode). PLATFORM code. A case
// chapter may carry up to three lines of counsel (Challenge.counsel); counsel N is heard by handing the Guildmaster a
// magic scroll of tier N from the merchant (src/range/shop.ts), the same scrolls the bounties use. The gold was spent
// when the scroll was bought, so hearing counsel only marks that scroll used. A line the player has not heard never
// leaves the server, and a counsel already heard costs no second scroll.
import type { DatabaseSync } from 'node:sqlite';
import type { Lang } from '../core/i18n.js';
import { scrollBag, scrollFor, type ScrollKind } from '../range/shop.js';
import type { Chapter, Quest } from './types.js';

/** The counsel a player has heard on one case, by tier. */
export function counselHeard(db: DatabaseSync, userId: number, questId: string, chapter: number): Set<number> {
  const rows = db.prepare('SELECT tier FROM quest_counsel WHERE user_id = ? AND quest_id = ? AND chapter = ?').all(userId, questId, chapter) as
    { tier: number }[];
  return new Set(rows.map((r) => Number(r.tier)));
}

/** The case file's counsel for one player: every tier with its scroll, the words only of those heard; and their bag. */
export function counselView(db: DatabaseSync, userId: number, quest: Quest, c: Chapter, lang: Lang) {
  const lines = c.challenge?.counsel ?? [];
  if (lines.length === 0) return undefined;
  const heard = counselHeard(db, userId, quest.id, c.n);
  return {
    tiers: lines.map((line, i) => {
      const tier = i + 1;
      return { tier, kind: scrollFor(tier)!.kind, ...(heard.has(tier) ? { text: line[lang] } : {}) };
    }),
    bag: scrollBag(db, userId),
  };
}

export type HearResult =
  | { readonly ok: true; readonly text: string; readonly used: boolean }
  | { readonly ok: false; readonly error: 'unknown_tier' | 'no_scroll'; readonly kind?: ScrollKind };

/**
 * Hand the Guildmaster a scroll for counsel `tier` on chapter `c`. One IMMEDIATE transaction: the oldest unused scroll
 * of that tier is marked used (used_lab 'quest:<quest>:<chapter>') and the counsel recorded together, so two clicks at
 * once never spend two scrolls.
 */
export function hearCounsel(db: DatabaseSync, userId: number, quest: Quest, c: Chapter, tier: number, lang: Lang, at: number): HearResult {
  const line = c.challenge?.counsel?.[tier - 1];
  if (!line || !Number.isInteger(tier) || tier < 1) return { ok: false, error: 'unknown_tier' };
  if (counselHeard(db, userId, quest.id, c.n).has(tier)) return { ok: true, text: line[lang], used: false };
  const scroll = scrollFor(tier)!;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT id FROM range_scrolls WHERE user_id = ? AND kind = ? AND used_at = 0 ORDER BY id LIMIT 1').get(userId, scroll.kind) as
      { id: number } | undefined;
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'no_scroll', kind: scroll.kind }; }
    const fresh = db.prepare('INSERT OR IGNORE INTO quest_counsel (user_id, quest_id, chapter, tier, heard_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, quest.id, c.n, tier, at);
    if (Number(fresh.changes) === 0) { db.exec('ROLLBACK'); return { ok: true, text: line[lang], used: false }; }
    db.prepare('UPDATE range_scrolls SET used_lab = ?, used_tier = ?, used_at = ? WHERE id = ?').run(`quest:${quest.id}:${c.n}`, tier, at, row.id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return { ok: true, text: line[lang], used: true };
}
