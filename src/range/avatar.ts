// src/range/avatar.ts — "Choose your avatar" (portal mode). The guild offers a roster of illustrated adventurers
// (static/art/heroes/<id>.webp, a face crop <id>-face.webp); the player picks one. The portrait is drawn by
// core/views/avatar.ejs on the licence, the account button, the leaderboard and the chooser page. Stored as a JSON spec
// in `avatars` (src/db/avatars.sql): no row means the chooser was never offered, so the guild hall invites the player
// (with a "skip" that keeps the default adventurer). A write naming a hero outside the roster is refused; a stored hero
// that has left the roster reads as the default.
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from 'express';
import { sendPage } from '../core/render.js';
import type { RangeContext } from './types.js';
import { userOf } from './user.js';
import { rangeView } from './catalog.js';

/** The roster: each hero's class (i18n hero.cls.<cls>) and banner colour (app.css [data-color]). */
export const HEROES = Object.freeze([
  Object.freeze({ id: 'kael', cls: 'warrior', color: 'crimson' }),
  Object.freeze({ id: 'seraphine', cls: 'duelist', color: 'azure' }),
  Object.freeze({ id: 'morrigan', cls: 'necromancer', color: 'amethyst' }),
  Object.freeze({ id: 'vesper', cls: 'warlock', color: 'onyx' }),
  Object.freeze({ id: 'lyra', cls: 'druid', color: 'emerald' }),
  Object.freeze({ id: 'faelan', cls: 'ranger', color: 'amber' }),
  Object.freeze({ id: 'rook', cls: 'rogue', color: 'onyx' }),
  Object.freeze({ id: 'aeris', cls: 'scout', color: 'emerald' }),
  Object.freeze({ id: 'corin', cls: 'bard', color: 'azure' }),
  Object.freeze({ id: 'elise', cls: 'alchemist', color: 'amber' }),
  Object.freeze({ id: 'theo', cls: 'scholar', color: 'amethyst' }),
  Object.freeze({ id: 'roland', cls: 'prince', color: 'crimson' }),
] as const);

export type Hero = (typeof HEROES)[number];
export type HeroId = Hero['id'];
export interface Avatar {
  readonly hero: HeroId;
  readonly cls: Hero['cls'];
  readonly color: Hero['color'];
  readonly skipped: boolean;
}

const heroOf = (x: unknown): Hero | undefined => HEROES.find((h) => h.id === x);
const DEFAULT_HERO = HEROES.find((h) => h.id === 'faelan')!;
const avatarFor = (h: Hero, skipped: boolean): Avatar => ({ hero: h.id, cls: h.cls, color: h.color, skipped });

export const DEFAULT_AVATAR: Avatar = Object.freeze(avatarFor(DEFAULT_HERO, true));

/** A submitted choice: the hero's id, or undefined when it is not on the roster. */
export function parseAvatar(body: unknown): HeroId | undefined {
  return heroOf((body as Record<string, unknown> | undefined)?.hero)?.id;
}

function readSpec(raw: string, skipped: boolean): Avatar {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return avatarFor(heroOf((parsed as Record<string, unknown> | null)?.hero) ?? DEFAULT_HERO, skipped);
}

/** The player's adventurer, or undefined when the chooser was never offered (no row). */
export function avatarOf(db: DatabaseSync, userId: number): Avatar | undefined {
  const row = db.prepare('SELECT spec, skipped FROM avatars WHERE user_id = ?').get(userId) as { spec: string; skipped: number } | undefined;
  return row ? readSpec(row.spec, row.skipped === 1) : undefined;
}

/** Save (or replace) the player's adventurer. */
export function saveAvatar(db: DatabaseSync, userId: number, hero: HeroId, skipped: boolean, now: number): void {
  db.prepare(`INSERT INTO avatars (user_id, spec, skipped, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET spec = excluded.spec, skipped = excluded.skipped, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify({ hero }), skipped ? 1 : 0, now);
}

/** Every chosen adventurer by user id (the leaderboard draws them; a player without a row gets the default). */
export function avatarsByUser(db: DatabaseSync): Map<number, Avatar> {
  const rows = db.prepare('SELECT user_id, spec, skipped FROM avatars').all() as { user_id: number; spec: string; skipped: number }[];
  return new Map(rows.map((r) => [r.user_id, readSpec(r.spec, r.skipped === 1)]));
}

/** The chooser (GET /adventurer), saving (POST /adventurer) and skipping (POST /adventurer/skip). */
export function avatarRoutes(router: Router, ctx: RangeContext): void {
  const { db, auth } = ctx;
  router.get('/adventurer', async (req, res) => {
    const { userId, username } = userOf(res);
    const t = res.locals.t;
    const current = avatarOf(db, userId);
    await sendPage(res, rangeView('adventurer'), {
      pageTitle: t('avatar.title'), csrf: auth.csrfFor(req), username,
      choice: current ?? DEFAULT_AVATAR, firstTime: current === undefined, heroes: HEROES,
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: t('avatar.title') }],
    });
  });
  router.post('/adventurer', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/adventurer'); return; }
    const hero = parseAvatar(req.body);
    if (!hero) { res.redirect(303, '/adventurer'); return; }
    saveAvatar(db, userOf(res).userId, hero, false, ctx.now());
    res.redirect(303, '/?made=1');
  });
  router.post('/adventurer/skip', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/'); return; }
    const { userId } = userOf(res);
    // Skipping never overwrites an adventurer someone already chose.
    if (!avatarOf(db, userId)) saveAvatar(db, userId, DEFAULT_HERO.id, true, ctx.now());
    res.redirect(303, '/');
  });
}
