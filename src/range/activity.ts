// src/range/activity.ts — the activity feed for the later admin dashboard (activity_log, migration 5). Everything here
// is a helper: routes call logActivity after a state change; the admin dashboard will call the read helpers. `detail`
// carries machine-readable context only (points, reason codes, outcome); it NEVER carries a flag, token or secret.
import type { DatabaseSync } from 'node:sqlite';

/** Newest rows kept, and the age a row is pruned at. Bounded retention, enforced on every insert (cheap). */
export const ACTIVITY_MAX_ROWS = 20_000;
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface ActivityEvent {
  /** One of the closed set documented in docs (team.*, range.*, auth.*). */
  readonly event: string;
  readonly userId?: number;
  readonly username?: string;
  readonly teamId?: number;
  readonly teamName?: string;
  readonly labId?: string;
  readonly level?: string;
  /** Machine-readable detail only (points, reason code, outcome). Never a flag or secret. */
  readonly detail?: string;
  readonly ip?: string;
  readonly now?: number;
}

export interface ActivityRow {
  readonly id: number;
  readonly at: number;
  readonly userId: number | null;
  readonly username: string | null;
  readonly teamId: number | null;
  readonly teamName: string | null;
  readonly event: string;
  readonly labId: string | null;
  readonly level: string | null;
  readonly detail: string | null;
  readonly ip: string | null;
}

export function logActivity(db: DatabaseSync, e: ActivityEvent): void {
  const at = e.now ?? Date.now();
  db.prepare(`INSERT INTO activity_log (at, user_id, username, team_id, team_name, event, lab_id, level, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(at, e.userId ?? null, e.username ?? null, e.teamId ?? null, e.teamName ?? null, e.event,
      e.labId ?? null, e.level ?? null, e.detail ?? null, e.ip ?? null);
  // Bounded retention: prune rows older than 30 days and keep only the newest ACTIVITY_MAX_ROWS.
  db.prepare(`DELETE FROM activity_log WHERE at < ? OR id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ?)`)
    .run(at - ACTIVITY_MAX_AGE_MS, ACTIVITY_MAX_ROWS);
}

const SELECT = `SELECT id, at, user_id, username, team_id, team_name, event, lab_id, level, detail, ip FROM activity_log`;
const toRow = (r: { id: number; at: number; user_id: number | null; username: string | null; team_id: number | null;
  team_name: string | null; event: string; lab_id: string | null; level: string | null; detail: string | null; ip: string | null }): ActivityRow =>
  ({ id: Number(r.id), at: Number(r.at), userId: r.user_id === null ? null : Number(r.user_id), username: r.username,
    teamId: r.team_id === null ? null : Number(r.team_id), teamName: r.team_name, event: r.event, labId: r.lab_id,
    level: r.level, detail: r.detail, ip: r.ip });

export interface ActivityFilter {
  /** One event name, or a prefix ending in '.' (e.g. 'range.'). */
  readonly event?: string;
  readonly userId?: number;
  readonly teamId?: number;
  readonly labId?: string;
  /** Most recent first, offset for pagination (default 0). */
  readonly offset?: number;
  readonly limit?: number;
}

/** Newest-first activity rows with optional filters and pagination (the admin dashboard's feed). */
export function latestActivity(db: DatabaseSync, f: ActivityFilter = {}): ActivityRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.event !== undefined) {
    where.push(f.event.endsWith('.') ? 'event LIKE ?' : 'event = ?');
    args.push(f.event.endsWith('.') ? `${f.event}%` : f.event);
  }
  if (f.userId !== undefined) { where.push('user_id = ?'); args.push(f.userId); }
  if (f.teamId !== undefined) { where.push('team_id = ?'); args.push(f.teamId); }
  if (f.labId !== undefined) { where.push('lab_id = ?'); args.push(f.labId); }
  const sql = `${SELECT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, f.limit ?? 100, f.offset ?? 0) as Parameters<typeof toRow>[0][];
  return rows.map(toRow);
}

/** The live exploit feed: accepted range.exploit rows, newest first (the admin dashboard's marquee). */
export function liveExploitFeed(db: DatabaseSync, limit = 50): ActivityRow[] {
  const rows = db.prepare(`${SELECT} WHERE event = 'range.exploit' ORDER BY id DESC LIMIT ?`).all(limit) as Parameters<typeof toRow>[0][];
  return rows.map(toRow);
}
