// src/range/submit.ts — flag submission (spec range §6): a flag counts when it equals the flag of one of the SUBMITTING
// user's instances of this lab, created within the last 24 h. Records keep the flag's SHA-256, so the lookup is by hash;
// the level comes from that record, never from the client. A flag from another user's instance never matches.
import type { DatabaseSync } from 'node:sqlite';
import { escapeHtml } from '../core/render.js';
import type { Level } from '../core/levels.js';
import { labPoints, type LabEntry } from '../lab-registry.js';
import { flagHash, RANGE_FLAG_RE } from './flags.js';
import { recordRangeSolve, type Best } from './progress.js';
import type { InstanceStore } from './store.js';

export const FLAG_WINDOW_MS = 24 * 60 * 60_000;

export type RangeSubmitResult =
  | { readonly status: 'wrong' }
  | { readonly status: 'new_best' | 'same_or_lower'; readonly level: Level; readonly points: number; readonly gained: number; readonly best: Best };

export function submitRangeFlag(db: DatabaseSync, store: InstanceStore, lab: LabEntry, userId: number, submission: string, now: number): RangeSubmitResult {
  const flag = submission.trim();
  if (!RANGE_FLAG_RE.test(flag)) return { status: 'wrong' };
  const level = store.levelForFlag(userId, lab.id, flagHash(flag), now - FLAG_WINDOW_MS);
  if (level === undefined || level === 'divine') return { status: 'wrong' };
  const points = labPoints(lab, level);
  const r = recordRangeSolve(db, userId, lab.id, level, points, now);
  return { status: r.status, level, points, gained: r.gained, best: r.best };
}

/** The htmx fragment (escaped): the same wording and hooks as the standalone portal's result. */
export function submitResultHtml(r: RangeSubmitResult, t: (key: string) => string): string {
  // tabindex="-1" + data-focus-after-swap: ui.js moves focus to this fragment after the htmx swap.
  if (r.status === 'wrong') {
    return `<p class="result result-bad" data-solved="false" data-result="wrong" role="status" tabindex="-1" data-focus-after-swap>${escapeHtml(t('challenge.result_bad'))}</p>`;
  }
  const key = r.status === 'new_best' ? 'new_best' : r.level === r.best.level ? 'already' : 'lower';
  const level = t(`level.${r.level}`);
  const msg = key === 'new_best'
    ? `${t('challenge.result_new_best')} ${level} (+${r.gained} ${t('challenge.points')})`
    : key === 'lower' ? `${t('challenge.result_lower')} ${t(`level.${r.best.level}`)}` : `${t('challenge.result_already')} ${level}`;
  return `<p class="result result-ok" data-solved="true" data-result="${key}" role="status" tabindex="-1" data-focus-after-swap>${escapeHtml(msg)}</p>`;
}
