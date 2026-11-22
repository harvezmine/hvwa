// src/range/admin.ts — the admin dashboard (portal mode, admin role only): the overview (counts, live exploit feed,
// running instances), the full activity feed with filters and pagination, a compact Portainer-like instances list with a
// Stop action, teams (create/delete/remove a member) and per-lab scoring modes. PLATFORM code: everything is read-only
// diagnostics or an admin action; never a flag, token or secret in the HTML or the logs. Every POST is an account form
// (Origin, Sec-Fetch-Site, the token bound to hvwa_sid + hvwa_auth). Mounted after requireAdmin, so a player or an
// anonymous user gets the same 404 as any unknown page.
import { Router } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin } from '../auth/index.js';
import { clientIp } from '../auth/client-ip.js';
import { field } from '../core/lab.js';
import { sendFragment, sendPage } from '../core/render.js';
import {
  ACTIVITY_EVENTS, ACTIVITY_GROUPS, countActivity, latestActivity, liveExploitFeed, logActivity, queryActivity,
  type ActivityRow,
} from './activity.js';
import { isLabMode, labMode, labModeMeta, setLabMode } from './modes.js';
import { createTeam, deleteTeam, listTeams, MAX_TEAMS, removeTeamMember, teamById, teamMembers, teamOfUser, teamScore } from './teams.js';
import type { InstanceRecord } from './store.js';
import type { RangeContext } from './types.js';
import { userOf } from './user.js';

const adminViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(adminViewsDir, `${name}.ejs`);

/** The activity page shows this many rows per page. */
export const ACTIVITY_PAGE = 50;
/** How many rows the overview's live exploit feed and activity/instances previews hold. */
const PREVIEW = 10;

/** A compact UTC stamp (deterministic, no locale/tz), like the team leaderboard's last-solve column. */
const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
/** A short, monotone age: 12s / 5m / 1h 4m. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function usernameOf(db: DatabaseSync, userId: number): string {
  const r = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return r?.username ?? '';
}

/** The accepted-solve feed row the live fragment and the overview share. Points come from the machine detail `points:N`. */
function exploitRow(r: ActivityRow): { at: string; iso: string; user: string; team: string; lab: string; level: string; points: number } {
  const points = /^points:(\d+)$/.test(r.detail ?? '') ? Number((r.detail as string).slice('points:'.length)) : 0;
  return {
    at: utcStamp(r.at), iso: new Date(r.at).toISOString(), user: r.username ?? '—', team: r.teamName ?? '',
    lab: r.labId ?? '', level: r.level ?? '', points,
  };
}

function activityRow(r: ActivityRow) {
  return {
    at: utcStamp(r.at), iso: new Date(r.at).toISOString(), event: r.event, user: r.username ?? '', team: r.teamName ?? '',
    lab: r.labId ?? '', level: r.level ?? '', detail: r.detail ?? '', ip: r.ip ?? '',
  };
}

/** A lab id is a registry lab id (r00..r99); the activity lab filter accepts anything but only matches a real id. */
const labIdOf = (raw: string, ids: Set<string>) => (ids.has(raw) ? raw : '');

/** A calendar date (`YYYY-MM-DD`) as the start of that UTC day, or undefined when it does not parse. */
function dayStart(raw: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : undefined;
}

/** `/admin/activity?…` with the current filters and the given 1-based page (page 1 drops `page`). */
function activityHref(filter: Record<string, string>, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== '') params.set(k, v);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs === '' ? '/admin/activity' : `/admin/activity?${qs}`;
}

/** The instances table's row (and the overview's compact preview), with the warden's container state when it has one. */
function instanceRow(
  ctx: RangeContext, rec: InstanceRecord, containers: Map<string, string>, now: number, short: boolean,
) {
  const started = rec.startedAt ?? rec.createdAt;
  return {
    id: rec.id, displayId: short ? `${rec.id.slice(0, 10)}…` : rec.id, user: usernameOf(ctx.db, rec.userId) || `#${rec.userId}`,
    team: teamOfUser(ctx.db, rec.userId)?.name ?? '', lab: rec.labId, level: rec.level, state: rec.state,
    container: containers.get(rec.id) ?? '', started: utcStamp(started), age: ageLabel(now - started),
    expires: rec.expiresAt === null ? '' : utcStamp(rec.expiresAt),
    stopped: rec.endedAt === null ? '' : utcStamp(rec.endedAt), reason: rec.reason ?? '',
  };
}

/** A teams-table row: the name, its join code (an admin may see it), members, team score and creation time. */
function teamRow(db: DatabaseSync, team: ReturnType<typeof listTeams>[number]) {
  return {
    id: team.id, name: team.name, joinCode: team.joinCode, score: teamScore(db, team.id), created: utcStamp(team.createdAt),
    members: teamMembers(db, team.id),
  };
}

export function adminRoutes(router: Router, ctx: RangeContext): void {
  const { db, auth, registry, opts, now } = ctx;
  const lifecycle = ctx.lifecycle;

  const sub = Router();
  sub.use(requireAdmin);

  // The overview: ledger cards, the live exploit feed (htmx polling), the latest activity and running instances.
  sub.get('/admin', async (req, res) => {
    const store = lifecycle.store;
    const t0 = now();
    const live = store.countLive();
    const states = {
      queued: store.listByState('queued').length, starting: store.listByState('starting').length,
      running: store.listByState('running').length, stopping: store.listByState('stopping').length,
    };
    const users = Number((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c);
    const teams = Number((db.prepare('SELECT COUNT(*) AS c FROM teams').get() as { c: number }).c);
    const exploits = Number((db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE event = 'range.exploit' AND at >= ?")
      .get(t0 - 24 * 60 * 60_000) as { c: number }).c);
    const capacity = opts.limits.capacity;
    await sendPage(res, view('admin-overview'), {
      pageTitle: res.locals.t('admin.title'), adminActive: 'overview',
      crumbs: [{ label: res.locals.t('admin.title') }],
      live, capacity, nearCapacity: live >= capacity, users, teams, exploits, states,
      feed: liveExploitFeed(db, PREVIEW).map(exploitRow),
      activity: latestActivity(db, { limit: PREVIEW }).map(activityRow),
      instances: store.listActive().map((r) => instanceRow(ctx, r, new Map(), t0, true)),
    });
  });

  // The live exploit feed fragment (htmx polls this every 5 s). aria-live=polite, and no focus attribute: it never
  // steals focus. Read-only, so no CSRF.
  sub.get('/admin/live', async (req, res) => {
    await sendFragment(res, view('admin-live'), { feed: liveExploitFeed(db, PREVIEW).map(exploitRow) });
  });

  // The full activity feed: filters (event select with groups, user, team, lab, date) and 50 rows per page.
  sub.get('/admin/activity', async (req, res) => {
    const q = req.query;
    const event = typeof q.event === 'string' ? q.event : '';
    const user = typeof q.user === 'string' ? q.user.trim().slice(0, 80) : '';
    const team = typeof q.team === 'string' ? q.team.trim().slice(0, 80) : '';
    const lab = typeof q.lab === 'string' ? q.lab.trim().slice(0, 20) : '';
    const date = typeof q.date === 'string' ? q.date : '';
    const since = dayStart(date);
    const labIds = new Set(registry.labs.map((l) => l.id));
    const filter = { event, user, team, lab: labIdOf(lab, labIds), date };
    const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1);
    const query = {
      event: filter.event || undefined, user: filter.user || undefined, team: filter.team || undefined,
      labId: filter.lab || undefined, since,
    };
    const total = countActivity(db, query);
    const rows = queryActivity(db, { ...query, offset: (page - 1) * ACTIVITY_PAGE, limit: ACTIVITY_PAGE }).map(activityRow);
    const eventOptions = [
      { value: '', label: res.locals.t('admin.filter_all') },
      ...ACTIVITY_GROUPS.map((g) => ({ value: `${g}.`, label: `${g}.*` })),
      ...ACTIVITY_EVENTS.map((e) => ({ value: e, label: e })),
    ];
    await sendPage(res, view('admin-activity'), {
      pageTitle: res.locals.t('admin.activity_title'), adminActive: 'activity',
      crumbs: [{ label: res.locals.t('admin.title'), href: '/admin' }, { label: res.locals.t('admin.activity_title') }],
      rows, total, filter, eventOptions, labIds: [...labIds],
      prevHref: page > 1 ? activityHref(filter, page - 1) : '',
      nextHref: (page - 1) * ACTIVITY_PAGE + rows.length < total ? activityHref(filter, page + 1) : '',
    });
  });

  // A compact Portainer-like list: active instances (queued/starting/running/stopping) plus recent ended ones, with the
  // warden's container state where it is known. Read-only diagnostics: no socket, port or secret is shown.
  sub.get('/admin/instances', async (req, res) => {
    const store = lifecycle.store;
    const t0 = now();
    let containers = new Map<string, string>();
    let wardenDown = false;
    try { containers = new Map((await opts.warden.list()).map((l) => [l.instanceId, l.state])); } catch { wardenDown = true; }
    const active = [...store.listActive(), ...store.listByState('stopping')].map((r) => instanceRow(ctx, r, containers, t0, false));
    const ended = [...store.listByState('stopped'), ...store.listByState('failed')]
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, PREVIEW)
      .map((r) => instanceRow(ctx, r, containers, t0, false));
    const live = store.countLive();
    const capacity = opts.limits.capacity;
    await sendPage(res, view('admin-instances'), {
      pageTitle: res.locals.t('admin.instances_title'), adminActive: 'instances',
      crumbs: [{ label: res.locals.t('admin.title'), href: '/admin' }, { label: res.locals.t('admin.instances_title') }],
      active, ended, live, capacity, nearCapacity: live >= capacity, wardenDown, csrf: auth.csrfFor(req),
    });
  });

  // Stop one instance (the reaper's path, but on behalf of the admin): marks it stopped, removes the container, logs it.
  sub.post('/admin/instances/:id/stop', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/instances'); return; }
    const me = userOf(res);
    const rec = lifecycle.store.get(req.params.id);
    if (rec) {
      await lifecycle.stopInstance(rec.id, 'admin');
      logActivity(db, { event: 'admin.stop', userId: me.userId, username: me.username, labId: rec.labId, level: rec.level,
        detail: `instance:${rec.id}`, ip: clientIp(req), now: now() });
    }
    res.redirect(303, '/admin/instances');
  });

  // Teams: the table (join code visible to the admin), create, delete (confirm) and remove a member.
  sub.get('/admin/teams', async (req, res) => {
    const r = req.query.r;
    const error = r === 'name' || r === 'duplicate' || r === 'full' ? res.locals.t(`team.err_${r}`) : '';
    const teams = listTeams(db).map((t) => teamRow(db, t));
    await sendPage(res, view('admin-teams'), {
      pageTitle: res.locals.t('admin.teams_title'), adminActive: 'teams',
      crumbs: [{ label: res.locals.t('admin.title'), href: '/admin' }, { label: res.locals.t('admin.teams_title') }],
      teams, csrf: auth.csrfFor(req), error, maxTeams: MAX_TEAMS,
    });
  });

  sub.post('/admin/teams/create', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/teams'); return; }
    const me = userOf(res);
    const result = createTeam(db, field(req, 'name'), me.userId, now());
    if (result.ok) {
      logActivity(db, { event: 'admin.team.create', userId: me.userId, username: me.username, teamId: result.team.id,
        teamName: result.team.name, ip: clientIp(req), now: now() });
    }
    res.redirect(303, result.ok ? '/admin/teams' : `/admin/teams?r=${result.error}`);
  });

  sub.post('/admin/teams/:id/delete', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/teams'); return; }
    const me = userOf(res);
    const team = teamById(db, Number(req.params.id));
    if (team) {
      deleteTeam(db, team.id);
      logActivity(db, { event: 'admin.team.delete', userId: me.userId, username: me.username, teamId: team.id,
        teamName: team.name, ip: clientIp(req), now: now() });
    }
    res.redirect(303, '/admin/teams');
  });

  sub.post('/admin/teams/:id/members/:userId/remove', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/teams'); return; }
    removeTeamMember(db, Number(req.params.id), Number(req.params.userId));
    res.redirect(303, '/admin/teams');
  });

  // Labs: one row per registry lab with its mode (individual/team), a toggle/save form and the last update.
  sub.get('/admin/labs', async (req, res) => {
    const rows = registry.labs.map((lab) => {
      const meta = labModeMeta(db, lab.id);
      return {
        id: lab.id, app: lab.app, title: lab.title[req.lang], difficulty: lab.difficulty,
        mode: labMode(db, lab.id), updatedAt: meta ? utcStamp(meta.updatedAt) : '',
        updatedBy: meta?.updatedByName ?? '',
      };
    });
    await sendPage(res, view('admin-labs'), {
      pageTitle: res.locals.t('admin.labs_title'), adminActive: 'labs',
      crumbs: [{ label: res.locals.t('admin.title'), href: '/admin' }, { label: res.locals.t('admin.labs_title') }],
      labs: rows, csrf: auth.csrfFor(req),
    });
  });

  sub.post('/admin/labs/:id/mode', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/labs'); return; }
    const mode = field(req, 'mode');
    if (!isLabMode(mode)) { res.redirect(303, '/admin/labs'); return; }
    const me = userOf(res);
    setLabMode(db, lab.id, mode, me.userId, now());
    logActivity(db, { event: 'admin.mode', userId: me.userId, username: me.username, labId: lab.id,
      detail: `mode:${mode}`, ip: clientIp(req), now: now() });
    res.redirect(303, '/admin/labs');
  });

  router.use(sub);
}
