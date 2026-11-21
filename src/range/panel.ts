// src/range/panel.ts — view models of the Lab panel (one lab and level, on its page) and of the My Lab chip (every page).
// Polling (spec §5.3): every 1 s while starting, 30 s while running (the time left); never otherwise. The compact POC
// (plan amendment) has no FIFO queue and no Extend: a full range refuses the launch, and the panel never shows a queue
// position or an Extend button.
import type { Request, Response } from 'express';
import type { Level } from '../core/levels.js';
import type { LabEntry, LabRegistry } from '../lab-registry.js';
import type { InstanceRecord } from './store.js';
import type { RangeContext } from './types.js';

/** Failure reasons the panel can name (range.reason.<code>); anything else shows as 'unknown'. */
export const PANEL_REASONS = Object.freeze(['start_timeout', 'unhealthy', 'no_healthcheck', 'missing', 'crashed', 'exited', 'oom',
  'bad_request', 'unknown_lab', 'bad_level', 'exists', 'docker', 'unauthorized', 'unavailable'] as const);
/** A failure older than this no longer shows on the panel. */
export const FAILURE_SHOWN_MS = 15 * 60_000;

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
  /** The user's instance elsewhere, which Launch would stop. */
  readonly replaces?: { readonly app: string; readonly levelLabel: string };
  /** The range is at capacity: the launch was refused and nothing started. */
  readonly full: boolean;
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
  const label = (l: Level) => t(l === 'divine' ? 'challenge.divine_tab' : `level.${l}`);
  const base = {
    labId: lab.id, level, levelLabel: label(level), minutesLeft: 0, reason: '', full: notice === 'full',
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
  if (current) {
    return { ...base, state: 'none', replaces: { app: ctx.registry.get(current.labId)?.app ?? current.labId, levelLabel: label(current.level) } };
  }
  const latest = lifecycle.store.latestFor(userId, lab.id, level);
  if (notice !== 'full' && latest?.state === 'failed' && latest.endedAt !== null && now - latest.endedAt < FAILURE_SHOWN_MS) {
    const reason = (PANEL_REASONS as readonly string[]).includes(latest.reason ?? '') ? (latest.reason as string) : 'unknown';
    return { ...base, state: 'failed', reason };
  }
  return { ...base, state: 'none' };
}

export interface MyLabChip { readonly href: string; readonly state: string; readonly text: string }

/** The header's My Lab chip (res.locals.myLab). */
export function myLabChip(current: InstanceRecord | undefined, registry: LabRegistry, now: number, t: (key: string) => string): MyLabChip {
  if (!current) return { href: '/', state: 'none', text: t('range.my_lab_none') };
  const app = registry.get(current.labId)?.app ?? current.labId;
  const href = `/labs/${current.labId}?level=${current.level}`;
  if (current.state === 'running') {
    return { href, state: 'running', text: `${app} · ${t('range.time_left').replace('{n}', String(minutesUntil(current.expiresAt, now)))}` };
  }
  return { href, state: current.state, text: `${app} · ${t(`range.state.${current.state}`)}` };
}
