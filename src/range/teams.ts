// src/range/teams.ts — teams (migration 5): one team per user, a generated join code, and team-mode scoring. The service
// functions are the data model the later admin dashboard consumes (create/delete are exposed here; only the player
// page and these routes call them for now). The team page (GET/POST /team) is a plain form page: CSRF, Origin and
// Sec-Fetch-Site guards on every POST, every value escaped in the view.
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { clientIp } from '../auth/client-ip.js';
import { logActivity } from './activity.js';
import { userOf } from './user.js';
import type { RangeContext } from './types.js';

/** At most this many teams may exist (the leaderboard and join-code space stay bounded). */
export const MAX_TEAMS = 20;
export const JOIN_CODE_RE = /^[A-Z2-7]{8}$/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface Team {
  readonly id: number;
  readonly name: string;
  readonly joinCode: string;
  readonly createdBy: number;
  readonly createdAt: number;
}
export interface TeamMember { readonly userId: number; readonly username: string; readonly joinedAt: number }

export type CreateTeamResult = { ok: true; team: Team } | { ok: false; error: 'name' | 'duplicate' | 'full' };
export type JoinTeamResult = { ok: true; team: Team } | { ok: false; error: 'code' | 'already' };

interface TeamRow { id: number; name: string; join_code: string; created_by: number; created_at: number }
const toTeam = (r: TeamRow): Team => ({
  id: Number(r.id), name: r.name, joinCode: r.join_code, createdBy: Number(r.created_by), createdAt: Number(r.created_at),
});

/** 8 base32 characters from 40 bits of entropy (5 bits per character). */
function newJoinCode(): string {
  const bytes = randomBytes(5);
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += BASE32[(acc >> bits) & 31]; }
  }
  return out;
}

function uniqueJoinCode(db: DatabaseSync): string {
  for (;;) {
    const code = newJoinCode();
    if (db.prepare('SELECT 1 AS taken FROM teams WHERE join_code = ?').get(code) === undefined) return code;
  }
}

/**
 * Create a team and make `createdBy` its first member. Names are trimmed and must be 3-32 characters; names are unique
 * whatever their case. At most MAX_TEAMS teams.
 */
export function createTeam(db: DatabaseSync, name: string, createdBy: number, at: number): CreateTeamResult {
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 32) return { ok: false, error: 'name' };
  const count = Number((db.prepare('SELECT COUNT(*) AS c FROM teams').get() as { c: number }).c);
  if (count >= MAX_TEAMS) return { ok: false, error: 'full' };
  const code = uniqueJoinCode(db);
  try {
    const info = db.prepare('INSERT INTO teams (name, join_code, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(trimmed, code, createdBy, at);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, createdBy, at);
    return { ok: true, team: { id, name: trimmed, joinCode: code, createdBy, createdAt: at } };
  } catch (err) {
    // The only UNIQUE an insert can hit here is the case-insensitive name (join_code was generated fresh).
    if (/UNIQUE constraint failed/.test(String(err))) return { ok: false, error: 'duplicate' };
    throw err;
  }
}

/** Join a team by its join code (case-insensitive on the way in: codes are stored upper case). One team per user. */
export function joinTeam(db: DatabaseSync, userId: number, rawCode: string, at: number): JoinTeamResult {
  const code = rawCode.trim().toUpperCase();
  const row = db.prepare('SELECT id, name, join_code, created_by, created_at FROM teams WHERE join_code = ?').get(code) as TeamRow | undefined;
  if (!row) return { ok: false, error: 'code' };
  try {
    db.prepare('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)').run(row.id, userId, at);
  } catch (err) {
    if (/UNIQUE constraint failed/.test(String(err))) return { ok: false, error: 'already' }; // user_id UNIQUE
    throw err;
  }
  return { ok: true, team: toTeam(row) };
}

/**
 * Leave the user's team. When the last member leaves, the team is deleted (an empty team would be a dangling shell and
 * its name freed for reuse). Returns whether the user was a member.
 */
export function leaveTeam(db: DatabaseSync, userId: number): { ok: true; left: boolean } {
  const member = db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').get(userId) as { team_id: number } | undefined;
  if (!member) return { ok: true, left: false };
  db.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
  const remaining = Number((db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(member.team_id) as { c: number }).c);
  if (remaining === 0) db.prepare('DELETE FROM teams WHERE id = ?').run(member.team_id);
  return { ok: true, left: true };
}

/** The team the user belongs to, or undefined. */
export function teamOfUser(db: DatabaseSync, userId: number): Team | undefined {
  const row = db.prepare(`SELECT t.id, t.name, t.join_code, t.created_by, t.created_at
    FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?`).get(userId) as TeamRow | undefined;
  return row ? toTeam(row) : undefined;
}

/** A team's members, by join time then name. */
export function teamMembers(db: DatabaseSync, teamId: number): TeamMember[] {
  return (db.prepare(`SELECT m.user_id, u.username, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id
    WHERE m.team_id = ? ORDER BY m.joined_at, u.username COLLATE NOCASE`).all(teamId) as
    { user_id: number; username: string; joined_at: number }[])
    .map((r) => ({ userId: Number(r.user_id), username: r.username, joinedAt: Number(r.joined_at) }));
}

/** A team by id, or undefined. */
export function teamById(db: DatabaseSync, teamId: number): Team | undefined {
  const row = db.prepare('SELECT id, name, join_code, created_by, created_at FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
  return row ? toTeam(row) : undefined;
}

/** Every team, oldest first (the admin dashboard's Teams table). */
export function listTeams(db: DatabaseSync): Team[] {
  const rows = db.prepare('SELECT id, name, join_code, created_by, created_at FROM teams ORDER BY created_at, id').all() as
    { id: number; name: string; join_code: string; created_by: number; created_at: number }[];
  return rows.map(toTeam);
}

/** Delete a team and every membership (the admin dashboard's delete); frees the name for reuse. */
export function deleteTeam(db: DatabaseSync, teamId: number): void {
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
}

/** Remove one member from a team; when that empties the team, it is deleted (the same rule as leaveTeam). */
export function removeTeamMember(db: DatabaseSync, teamId: number, userId: number): void {
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
  const remaining = Number((db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(teamId) as { c: number }).c);
  if (remaining === 0) db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
}

/**
 * TEAM SCORING RULE — for each lab in team mode only, take the best level solved by any member (max points per lab,
 * which equals the max level rank) and sum those points; a lab solved by several members still counts once. Disabled
 * users are excluded. Hint costs are not deducted (team bounty is raw best-level points). Individual scores are
 * unaffected. Ties break by the earlier last solve.
 */
export function teamScore(db: DatabaseSync, teamId: number): number {
  const r = db.prepare(`SELECT COALESCE(SUM(pts), 0) AS score FROM (
      SELECT rs.lab_id, MAX(rs.points) AS pts
      FROM team_members m
      JOIN users u ON u.id = m.user_id
      JOIN range_solves rs ON rs.user_id = m.user_id
      JOIN lab_modes lm ON lm.lab_id = rs.lab_id AND lm.mode = 'team'
      WHERE m.team_id = ? AND u.disabled = 0
      GROUP BY rs.lab_id)`).get(teamId) as { score: number };
  return Number(r.score);
}

export interface TeamLeaderRow {
  readonly rank: number;
  readonly teamId: number;
  readonly name: string;
  readonly score: number;
  readonly solved: number;
  readonly members: number;
  readonly lastSolveAt: number;
}

/** The team leaderboard: every team, ranked by score, then by the earlier last solve, then name. */
export function teamLeaderboard(db: DatabaseSync, limit = 100): TeamLeaderRow[] {
  const rows = db.prepare(`
    WITH solved AS (
      SELECT m.team_id, rs.lab_id, MAX(rs.points) AS pts, MAX(rs.solved_at) AS at
      FROM team_members m
      JOIN users u ON u.id = m.user_id
      JOIN range_solves rs ON rs.user_id = m.user_id
      JOIN lab_modes lm ON lm.lab_id = rs.lab_id AND lm.mode = 'team'
      WHERE u.disabled = 0
      GROUP BY m.team_id, rs.lab_id
    ),
    agg AS (SELECT team_id, SUM(pts) AS score, COUNT(*) AS solved, MAX(at) AS last_at FROM solved GROUP BY team_id),
    mcount AS (SELECT team_id, COUNT(*) AS members FROM team_members GROUP BY team_id)
    SELECT t.id AS id, t.name AS name, COALESCE(a.score, 0) AS score, COALESCE(a.solved, 0) AS solved,
           COALESCE(mc.members, 0) AS members, COALESCE(a.last_at, 0) AS last_at
    FROM teams t
    LEFT JOIN agg a ON a.team_id = t.id
    LEFT JOIN mcount mc ON mc.team_id = t.id
    ORDER BY score DESC, last_at ASC, t.name COLLATE NOCASE ASC
    LIMIT ?`).all(limit) as { id: number; name: string; score: number; solved: number; members: number; last_at: number }[];
  return rows.map((r, i) => ({
    rank: i + 1, teamId: Number(r.id), name: r.name, score: Number(r.score), solved: Number(r.solved),
    members: Number(r.members), lastSolveAt: Number(r.last_at),
  }));
}

export const teamViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const teamView = join(teamViewsDir, 'team.ejs');

type TeamError = 'name' | 'duplicate' | 'full' | 'code' | 'already';
const ERROR_KEY: Readonly<Record<TeamError, string>> = Object.freeze({
  name: 'team.err_name', duplicate: 'team.err_duplicate', full: 'team.err_full', code: 'team.err_code', already: 'team.err_already',
});

export function teamRoutes(router: Router, ctx: RangeContext): void {
  const { db, auth } = ctx;

  const render = async (req: Request, res: Response, me: ReturnType<typeof userOf>) => {
    const t = res.locals.t;
    const team = teamOfUser(db, me.userId);
    const q = req.query.r;
    const code = typeof q === 'string' ? q : '';
    const error = code in ERROR_KEY ? t(ERROR_KEY[code as TeamError]) : '';
    const notice = code === 'left' ? t('team.left_ok') : '';
    const data = team
      ? {
          hasTeam: true, csrf: auth.csrfFor(req), error, notice,
          team: {
            name: team.name, joinCode: team.joinCode, score: teamScore(db, team.id),
            members: teamMembers(db, team.id).map((m) => ({ ...m, isSelf: m.userId === me.userId })),
          },
        }
      : { hasTeam: false, csrf: auth.csrfFor(req), error, notice, maxTeams: MAX_TEAMS };
    await sendPage(res, teamView, {
      pageTitle: t('team.title'), ...data,
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: t('team.title') }],
    });
  };

  router.get('/team', async (req, res) => { await render(req, res, userOf(res)); });

  router.post('/team/create', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/team'); return; }
    const me = userOf(res);
    const result = createTeam(db, field(req, 'name'), me.userId, ctx.now());
    if (result.ok) {
      logActivity(db, { event: 'team.create', userId: me.userId, username: me.username, teamId: result.team.id,
        teamName: result.team.name, ip: clientIp(req), now: ctx.now() });
    }
    res.redirect(303, result.ok ? '/team' : `/team?r=${result.error}`);
  });

  router.post('/team/join', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/team'); return; }
    const me = userOf(res);
    const result = joinTeam(db, me.userId, field(req, 'code'), ctx.now());
    if (result.ok) {
      logActivity(db, { event: 'team.join', userId: me.userId, username: me.username, teamId: result.team.id,
        teamName: result.team.name, ip: clientIp(req), now: ctx.now() });
    }
    res.redirect(303, result.ok ? '/team' : `/team?r=${result.error}`);
  });

  router.post('/team/leave', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/team'); return; }
    const me = userOf(res);
    const team = teamOfUser(db, me.userId);
    leaveTeam(db, me.userId);
    logActivity(db, { event: 'team.leave', userId: me.userId, username: me.username, teamId: team?.id,
      teamName: team?.name, ip: clientIp(req), now: ctx.now() });
    res.redirect(303, '/team?r=left');
  });
}
