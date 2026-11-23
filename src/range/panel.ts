// src/range/panel.ts — view models of the Lab panel (one lab and level, on its page) and of the My Lab chip (every page).
// Polling (spec §5.3): every 1 s while starting, 30 s while running (the time left); never otherwise. The compact POC
// (plan amendment) has no FIFO queue and no Extend: a full range refuses the launch, and the panel never shows a queue
// position or an Extend button.
import type { Request, Response } from 'express';
import type { Level } from '../core/levels.js';
import type { LabEntry, LabRegistry } from '../lab-registry.js';
import { isActiveState, type InstanceRecord } from './store.js';
import type { RangeContext } from './types.js';

/** Failure reasons the panel can name (range.reason.<code>); anything else shows as 'unknown'. */
export const PANEL_REASONS = Object.freeze(['start_timeout', 'unhealthy', 'no_healthcheck', 'missing', 'crashed', 'exited', 'oom',
  'bad_request', 'unknown_lab', 'bad_level', 'exists', 'docker', 'unauthorized', 'unavailable'] as const);
/** Stop reasons whose notice is worth showing with a relaunch path (range.stopped.<reason>). */
export const PANEL_STOP_REASONS = Object.freeze(['expired', 'idle', 'replaced'] as const);
/** A failure — or a stop — older than this no longer shows on the panel or the My Lab chip. */
export const FAILURE_SHOWN_MS = 15 * 60_000;
/** The My Lab chip also shows a recently ended instance for this long, so a player can relaunch it. */
export const MY_LAB_RECENT_MS = FAILURE_SHOWN_MS;

/** A threat level as the guild names it (Common / Dangerous / Deadly / Warded); `long` adds "(secure reference)" to Warded. */
export function tierLabel(t: (key: string) => string, level: Level, long = false): string {
  return t(long && level === "divine" ? "range.tier_long.divine" : `range.tier.${level}`);
}

/** What the panel shows: not running, being prepared, running, or the last attempt failed. */
export type PanelState = 'none' | 'starting' | 'running' | 'failed';

export interface PanelModel {
  readonly labId: string;
  readonly level: Level;
  readonly levelLabel: string;
  readonly state: PanelState;
  readonly minutesLeft: number;
  /** A PANEL_REASONS code or 'unknown' when failed; '' otherwise. */
  readonly reason: string;
  /** A recent stop reason (expired, idle, replaced) worth a notice; undefined otherwise. */
  readonly stoppedReason?: string;
  /** The user's instance elsewhere, which Launch would stop. */
  readonly replaces?: { readonly app: string; readonly levelLabel: string };
  /** The range is at capacity: the launch was refused and nothing started. */
  readonly full: boolean;
  /** The idle limit, in minutes (the "stops after N minutes idle" rule). */
  readonly idleMinutes: number;
  /** The lifetime limit, in minutes (the thin time bar's scale). */
  readonly maxMinutes: number;
  /** 0: no polling. */
  readonly pollSeconds: number;
  readonly csrf: string;
}

const minutesUntil = (at: number | null, now: number) => (at === null ? 0 : Math.max(0, Math.ceil((at - now) / 60_000)));

/** The panel for `lab` at `level`, as the signed-in user sees it now; `notice` carries a launch outcome from this request. */
export function panelFor(ctx: RangeContext, req: Request, res: Response, lab: LabEntry, level: Level, notice?: 'full'): PanelModel {
  const t: (key: string) => string = res.locals.t;
  const userId = res.locals.platformAuth?.userId ?? 0;
  const { lifecycle } = ctx;
  const now = ctx.now();
  const current = lifecycle.current(userId);
  const base = {
    labId: lab.id, level, levelLabel: tierLabel(t, level, true), minutesLeft: 0, reason: '', full: notice === 'full',
    idleMinutes: Math.max(1, Math.round(ctx.opts.limits.idleMs / 60_000)),
    maxMinutes: Math.max(1, Math.round(ctx.opts.limits.maxMs / 60_000)),
    pollSeconds: 0, csrf: ctx.auth.csrfFor(req),
  };
  if (current && current.labId === lab.id && current.level === level) {
    const state: PanelState = current.state === 'running' ? 'running' : current.state === 'starting' ? 'starting' : 'none';
    return {
      ...base, full: false, state,
      minutesLeft: state === 'running' ? minutesUntil(current.expiresAt, now) : 0,
      pollSeconds: state === 'starting' ? 1 : state === 'running' ? 30 : 0,
    };
  }
  // The user's instance elsewhere (a different lab or level): Launch here would replace it.
  const replaces = current === undefined ? undefined
    : { app: ctx.registry.get(current.labId)?.app ?? current.labId, levelLabel: tierLabel(t, current.level, true) };
  // This lab at this level, if one ended recently: show why, with the Launch button as the relaunch path.
  const latest = lifecycle.store.latestFor(userId, lab.id, level);
  const recent = latest !== undefined && latest.endedAt !== null && now - latest.endedAt < FAILURE_SHOWN_MS;
  if (notice !== 'full' && recent && latest !== undefined) {
    if (latest.state === 'failed') {
      const reason = (PANEL_REASONS as readonly string[]).includes(latest.reason ?? '') ? (latest.reason as string) : 'unknown';
      return { ...base, state: 'failed', reason, ...(replaces === undefined ? {} : { replaces }) };
    }
    if (latest.state === 'stopped' && (PANEL_STOP_REASONS as readonly string[]).includes(latest.reason ?? '')) {
      // Its container is gone, so the only action is to launch again (the relaunch path the panel already renders).
      return { ...base, state: 'none', stoppedReason: latest.reason as string, ...(replaces === undefined ? {} : { replaces }) };
    }
  }
  if (replaces !== undefined) return { ...base, state: 'none', replaces };
  return { ...base, state: 'none' };
}

export interface MyLabChip { readonly href: string; readonly state: string; readonly label: string; readonly text: string }

/**
 * The header's My Lab chip (res.locals.myLab). `latest` is the user's newest instance of any state. The chip is HIDDEN
 * (undefined) when there is neither an active instance nor one that ended recently, and it names a failed or stopped
 * instance so the player can relaunch it from the lab page.
 */
export function myLabChip(
  latest: InstanceRecord | undefined, registry: LabRegistry, now: number, t: (key: string) => string, lang: 'en' | 'id' = 'en',
): MyLabChip | undefined {
  if (!latest) return undefined;
  const active = isActiveState(latest.state);
  const recent = latest.endedAt !== null && now - latest.endedAt < MY_LAB_RECENT_MS;
  if (!active && !recent) return undefined;
  const lab = registry.get(latest.labId);
  // The challenge title is the primary label; the in-world app stays as context, then the state.
  const title = lab?.title[lang] ?? lab?.app ?? latest.labId;
  const app = lab?.app ?? latest.labId;
  const href = `/labs/${latest.labId}?level=${latest.level}`;
  const label = active ? t('range.my_lab_active') : t('range.my_lab_last');
  if (latest.state === 'running') {
    return { href, state: 'running', label, text: `${title} · ${app} · ${t('range.time_left').replace('{n}', String(minutesUntil(latest.expiresAt, now)))}` };
  }
  if (latest.state === 'failed') {
    return { href, state: 'failed', label, text: `${title} · ${app} · ${t('range.state.failed')}` };
  }
  if (latest.state === 'stopped') {
    const key = `range.stopped.${latest.reason ?? ''}`;
    const text = t(key) === key ? t('range.state.stopped') : t(key);
    return { href, state: 'stopped', label, text: `${title} · ${app} · ${text}` };
  }
  // starting (or queued, which the POC does not use)
  return { href, state: latest.state, label, text: `${title} · ${app} · ${t(`range.state.${latest.state}`)}` };
}
