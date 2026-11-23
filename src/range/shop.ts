// src/range/shop.ts — the merchant and the Guildmaster's counsel (portal mode). Hints are no longer bought one by one
// on a quest: the merchant sells magic scrolls, one kind per counsel tier, and on any quest the player hands a scroll
// to the Guildmaster, who then gives that quest's counsel of the scroll's tier.
// Gold: a scroll's price is spent when it is bought (rangeScore subtracts range_scrolls.cost); handing it over unlocks
// the counsel with cost 0, so a counsel is paid for exactly once. Like the old paid hints, a purchase is allowed even
// when the purse is short ("on the guild's tab"): the score is floored at 0, so learners are never locked out.
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from 'express';
import { escapeHtml, sendPage } from '../core/render.js';
import { parseTier } from '../core/hints.js';
import type { LabEntry } from '../lab-registry.js';
import { rangeScore } from './progress.js';
import type { RangeContext } from './types.js';
import { isHtmx, userOf } from './user.js';
import { rangeView } from './catalog.js';

/** The scroll kinds, in counsel order: a scroll of tier N unlocks counsel N on any quest. */
export const SCROLLS = Object.freeze([
  Object.freeze({ kind: 'insight', tier: 1, price: 10 }),
  Object.freeze({ kind: 'revelation', tier: 2, price: 20 }),
  Object.freeze({ kind: 'oracle', tier: 3, price: 30 }),
] as const);
export type ScrollKind = (typeof SCROLLS)[number]['kind'];

export const scrollFor = (tier: number) => SCROLLS.find((s) => s.tier === Math.min(tier, SCROLLS.length));
const scrollOf = (kind: unknown) => SCROLLS.find((s) => s.kind === kind);

/** Buy one scroll (its price is spent now). */
export function buyScroll(db: DatabaseSync, userId: number, kind: ScrollKind, at: number): void {
  const s = scrollOf(kind);
  if (!s) throw new Error(`shop: unknown scroll ${String(kind)}`);
  db.prepare('INSERT INTO range_scrolls (user_id, kind, cost, bought_at) VALUES (?, ?, ?, ?)').run(userId, s.kind, s.price, at);
}

/** The scrolls still in the player's bag, per kind. */
export function scrollBag(db: DatabaseSync, userId: number): Record<ScrollKind, number> {
  const bag = Object.fromEntries(SCROLLS.map((s) => [s.kind, 0])) as Record<ScrollKind, number>;
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM range_scrolls WHERE user_id = ? AND used_at = 0 GROUP BY kind').all(userId) as
    { kind: string; n: number }[];
  for (const r of rows) if (scrollOf(r.kind)) bag[r.kind as ScrollKind] = Number(r.n);
  return bag;
}

export type CounselResult =
  | { readonly ok: true; readonly hint: LabEntry['hints'][number]; readonly used: boolean }
  | { readonly ok: false; readonly error: 'unknown_tier' | 'no_scroll'; readonly kind?: ScrollKind };

/**
 * Hand a scroll to the Guildmaster for a quest's counsel of that scroll's tier. Idempotent: a counsel already heard
 * costs no second scroll. One transaction: the scroll is marked used and the counsel unlocked together.
 */
export function seekCounsel(db: DatabaseSync, userId: number, lab: LabEntry, tier: number, at: number): CounselResult {
  const hint = lab.hints.find((h) => h.id === tier);
  if (!hint) return { ok: false, error: 'unknown_tier' };
  const heard = db.prepare('SELECT 1 FROM range_hint_unlocks WHERE user_id = ? AND lab_id = ? AND tier = ?').get(userId, lab.id, tier);
  if (heard) return { ok: true, hint, used: false };
  const scroll = scrollFor(tier)!;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT id FROM range_scrolls WHERE user_id = ? AND kind = ? AND used_at = 0 ORDER BY id LIMIT 1').get(userId, scroll.kind) as
      { id: number } | undefined;
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'no_scroll', kind: scroll.kind }; }
    db.prepare('UPDATE range_scrolls SET used_lab = ?, used_tier = ?, used_at = ? WHERE id = ?').run(lab.id, tier, at, row.id);
    db.prepare('INSERT OR IGNORE INTO range_hint_unlocks (user_id, lab_id, tier, cost, unlocked_at) VALUES (?, ?, ?, 0, ?)').run(userId, lab.id, tier, at);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return { ok: true, hint, used: true };
}

/** The merchant's stall (GET /shop) and buying (POST /shop/buy). */
export function shopRoutes(router: Router, ctx: RangeContext): void {
  const { db, auth } = ctx;
  router.get('/shop', async (req, res) => {
    const { userId } = userOf(res);
    const t = res.locals.t;
    const bought = scrollOf(req.query.bought);
    const need = scrollOf(req.query.need);
    const back = typeof req.query.from === 'string' && ctx.registry.get(req.query.from) ? `/labs/${req.query.from}` : '';
    await sendPage(res, rangeView('shop'), {
      pageTitle: t('shop.title'), csrf: auth.csrfFor(req), gold: rangeScore(db, userId), bag: scrollBag(db, userId), scrolls: SCROLLS,
      bought: bought?.kind ?? '', need: need?.kind ?? '', back,
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: t('shop.title') }],
    });
  });
  router.post('/shop/buy', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/shop'); return; }
    const s = scrollOf(req.body?.kind);
    if (!s) { res.redirect(303, '/shop'); return; }
    buyScroll(db, userOf(res).userId, s.kind, ctx.now());
    const from = typeof req.body?.from === 'string' && ctx.registry.get(req.body.from) ? `&from=${encodeURIComponent(req.body.from)}` : '';
    res.redirect(303, `/shop?bought=${s.kind}${from}`);
  });
}

/** POST /labs/:id/hint: hand a scroll to the Guildmaster (htmx swaps in the counsel; without JS, a redirect). */
export function counselRoute(router: Router, ctx: RangeContext, counselHtml: (id: number, text: string, t: (k: string) => string) => string): void {
  const { db, auth, registry } = ctx;
  router.post('/labs/:id/hint', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const t = res.locals.t;
    const tier = parseTier(req.body?.tier);
    const result = tier === undefined ? undefined : seekCounsel(db, userOf(res).userId, lab, tier, ctx.now());
    if (!result?.ok) {
      const kind = result && !result.ok ? result.kind : undefined;
      if (isHtmx(req)) {
        const msg = kind ? t('gm.need_scroll').replace('{scroll}', t(`scroll.${kind}.name`)) : t('challenge.err_unknown_tier');
        res.status(400).type('html').send(`<p class="result result-bad" role="alert" data-error="${kind ? 'no_scroll' : 'tier'}">${escapeHtml(msg)}</p>`);
        return;
      }
      res.redirect(303, kind ? `/shop?need=${kind}&from=${lab.id}` : `/labs/${lab.id}`);
      return;
    }
    if (isHtmx(req)) { res.type('html').send(counselHtml(result.hint.id, result.hint.text[req.lang], t)); return; }
    res.redirect(303, `/labs/${lab.id}#hint-${result.hint.id}`);
  });
}
