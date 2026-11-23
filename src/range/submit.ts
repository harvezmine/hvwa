// src/range/submit.ts — flag submission (spec range §6): a flag counts when it equals the flag of one of the SUBMITTING
// user's instances of this lab, created within the last 24 h. Records keep the flag's SHA-256, so the lookup is by hash;
// the level comes from that record, never from the client. A flag from another user's instance never matches.
import type { DatabaseSync } from 'node:sqlite';
import { escapeHtml } from '../core/render.js';
import type { Lang } from '../core/i18n.js';
import type { Level } from '../core/levels.js';
import { labPoints, type LabEntry } from '../lab-registry.js';
import { labFact } from './facts.js';
import { flagHash, RANGE_FLAG_RE } from './flags.js';
import { decoyOf, type Decoy } from './decoys.js';
import { recordRangeSolve, type Best } from './progress.js';
import type { InstanceStore } from './store.js';

export const FLAG_WINDOW_MS = 24 * 60 * 60_000;

export type RangeSubmitResult =
  | { readonly status: 'wrong' }
  | { readonly status: 'decoy'; readonly decoy: Decoy }
  | { readonly status: 'new_best' | 'same_or_lower'; readonly level: Level; readonly points: number; readonly gained: number; readonly best: Best };

export function submitRangeFlag(db: DatabaseSync, store: InstanceStore, lab: LabEntry, userId: number, submission: string, now: number): RangeSubmitResult {
  const flag = submission.trim();
  // A honeypot the player dug out of the page source, a header, a decoy table, etc. — recognised so the popup can
  // mock them instead of a plain "wrong". Checked before the shape test, since decoys are deliberately malformed.
  const decoy = decoyOf(flag);
  if (decoy !== undefined) return { status: 'decoy', decoy };
  if (!RANGE_FLAG_RE.test(flag)) return { status: 'wrong' };
  const level = store.levelForFlag(userId, lab.id, flagHash(flag), now - FLAG_WINDOW_MS);
  if (level === undefined || level === 'divine') return { status: 'wrong' };
  const points = labPoints(lab, level);
  const r = recordRangeSolve(db, userId, lab.id, level, points, now);
  return { status: r.status, level, points, gained: r.gained, best: r.best };
}

/** The htmx fragment (escaped): the same wording and hooks as the standalone portal's result, plus the toast payload
 *  and the submit-result modal payload (data-modal-*). The modal is progressive enhancement driven by ui.js; the inline
 *  .result text stays as the no-JS fallback. The fact is shown only for a solved / new-best seal. */
export function submitResultHtml(r: RangeSubmitResult, t: (key: string) => string, labId: string, lang: Lang): string {
  // tabindex="-1" + data-focus-after-swap: ui.js moves focus to this fragment after the htmx swap; data-toast-* feeds a
  // toast, data-modal-* opens the solve dialog (both removed by ui.js after handling, so polls never re-trigger them).
  if (r.status === 'wrong') {
    return `<p class="result result-bad" data-solved="false" data-result="wrong" role="status" tabindex="-1" data-focus-after-swap data-toast="wrong" data-toast-variant="error" data-toast-title="${escapeHtml(t('range.toast_wrong_title'))}" data-toast-message="${escapeHtml(t('range.toast_wrong'))}" data-modal="wrong" data-modal-title="${escapeHtml(t('range.modal_wrong_title'))}" data-modal-message="${escapeHtml(t('range.modal_wrong_message'))}" data-modal-points="" data-modal-fact="">${escapeHtml(t('challenge.result_bad'))}</p>`;
  }
  if (r.status === 'decoy') {
    // A honeypot: mock the player for "outsmarting" the system, with a line flavoured by where they found it.
    const taunt = r.decoy.taunt[lang];
    return `<p class="result result-bad" data-solved="false" data-result="decoy" role="status" tabindex="-1" data-focus-after-swap data-toast="decoy" data-toast-variant="warning" data-toast-title="${escapeHtml(t('range.toast_decoy_title'))}" data-toast-message="${escapeHtml(t('range.toast_decoy'))}" data-modal="decoy" data-modal-title="${escapeHtml(t('range.modal_decoy_title'))}" data-modal-message="${escapeHtml(taunt)}" data-modal-points="" data-modal-fact="">${escapeHtml(t('range.result_decoy'))}</p>`;
  }
  const key = r.status === 'new_best' ? 'new_best' : r.level === r.best.level ? 'already' : 'lower';
  const level = t(`level.${r.level}`);
  const msg = key === 'new_best'
    ? `${t('challenge.result_new_best')} ${level} (+${r.gained} ${t('challenge.points')})`
    : key === 'lower' ? `${t('challenge.result_lower')} ${t(`level.${r.best.level}`)}` : `${t('challenge.result_already')} ${level}`;
  const toast = key === 'new_best'
    ? ` data-toast="solved" data-toast-variant="success" data-toast-title="${escapeHtml(t('range.toast_solved_title'))}" data-toast-message="${escapeHtml(t('range.toast_solved').replace('{level}', level).replace('{points}', String(r.gained)))}" data-level="${r.level}" data-points="${r.gained}"`
    : ` data-toast="already" data-toast-variant="info" data-toast-title="${escapeHtml(t('range.toast_already_title'))}" data-toast-message="${escapeHtml(t('range.toast_already').replace('{level}', t(`level.${r.best.level}`)))}" data-level="${r.best.level}" data-points="0"`;
  const bestLevel = t(`level.${r.best.level}`);
  const modal = key === 'new_best'
    ? ` data-modal="solved" data-modal-title="${escapeHtml(t('range.modal_solved_title'))}" data-modal-message="${escapeHtml(t('range.modal_solved_message').replace('{level}', level))}" data-modal-points="+${r.gained}" data-modal-fact="${escapeHtml(labFact(labId)?.[lang] ?? '')}"`
    : key === 'already'
      ? ` data-modal="already" data-modal-title="${escapeHtml(t('range.modal_already_title'))}" data-modal-message="${escapeHtml(t('range.modal_already_message').replace('{level}', bestLevel).replace('{points}', String(r.best.points)))}" data-modal-points="" data-modal-fact=""`
      : ` data-modal="lower" data-modal-title="${escapeHtml(t('range.modal_lower_title'))}" data-modal-message="${escapeHtml(t('range.modal_lower_message').replace('{level}', bestLevel).replace('{points}', String(r.best.points)))}" data-modal-points="" data-modal-fact=""`;
  return `<p class="result result-ok" data-solved="true" data-result="${key}" role="status" tabindex="-1" data-focus-after-swap${toast}${modal}>${escapeHtml(msg)}</p>`;
}
