// The admin dashboard (src/range/admin.ts): role-admin routes under /admin, the overview counts and live exploit feed,
// the filtered/paginated activity feed, a Portainer-like instances list with a Stop action, team create/delete and the
// per-lab mode switch. Players and anonymous users never reach it; no page or activity row carries a flag or secret.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb, migrate } from '../src/db/index.js';
import { countActivity, latestActivity, liveExploitFeed, logActivity, queryActivity } from '../src/range/activity.js';
import { labMode } from '../src/range/modes.js';
import { recordRangeSolve } from '../src/range/progress.js';
import { createTeam, joinTeam, listTeams, teamLeaderboard } from '../src/range/teams.js';
import { csrfOf } from './helpers.js';
import { player, portalApp, signInAdmin } from './support/range.js';

describe('admin access control', () => {
  it('anonymous -> login, a player -> 404, an admin -> the pages; the Admin link is admin-only', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const { agent } = await player(kit.app, 'alice');
    for (const path of ['/admin', '/admin/live', '/admin/activity', '/admin/instances', '/admin/teams', '/admin/labs']) {
      const anon = await request(kit.app).get(path);
      expect(anon.status, path).toBe(303);
      expect(anon.headers.location, path).toBe(`/login?next=${encodeURIComponent(path)}`);
      expect((await agent.get(path)).status, path).toBe(404);
      expect((await admin.get(path)).status, path).toBe(200);
    }
    expect((await agent.get('/')).text).not.toContain('data-testid="nav-admin"');
    expect((await admin.get('/')).text).toContain('data-testid="nav-admin"');
  });
});

describe('admin overview and live feed', () => {
  it('counts live instances, users, teams and 24h exploits; the feed shows accepted solves with no flag', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    await kit.app.locals.range!.lifecycle.launch(a.userId, 'r01', 'acolyte');
    await kit.app.locals.range!.lifecycle.launch(b.userId, 'r02', 'acolyte');
    createTeam(db, 'Crew', a.userId, kit.clock.now());
    logActivity(db, { event: 'range.exploit', userId: a.userId, username: 'alice', teamName: 'Crew', labId: 'r01',
      level: 'acolyte', detail: 'points:100', ip: '203.0.113.9', now: kit.clock.now() });
    logActivity(db, { event: 'range.exploit', userId: b.userId, username: 'bob', labId: 'r02', level: 'acolyte',
      detail: 'points:200', ip: '203.0.113.10', now: kit.clock.now() - 25 * 60 * 60 * 1000 });

    const html = (await admin.get('/admin')).text;
    expect(html).toMatch(/data-testid="admin-live">2 <span class="stat-of">of 140 capacity</);
    expect(html).toContain('data-testid="admin-users">3<');
    expect(html).toContain('data-testid="admin-teams">1<');
    expect(html).toContain('data-testid="admin-exploits">1<');
    expect(html).not.toContain('HVWA{');

    const live = (await admin.get('/admin/live')).text;
    expect(live).toContain('data-testid="admin-live-feed"');
    expect(live).toMatch(/data-user="alice"[^>]*data-lab="r01"/);
    expect(live).toContain('data-points="100"');
    expect(live).toContain('Crew');
    expect(live).not.toContain('HVWA{');
  });

  it('the overview shows the state counts and a near-capacity warning when full', async () => {
    const kit = portalApp({ range: { limits: { capacity: 2, idleMs: 20 * 60_000, maxMs: 60 * 60_000, startTimeoutMs: 90_000 } } });
    const admin = await signInAdmin(kit.app);
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    await kit.app.locals.range!.lifecycle.launch(a.userId, 'r01', 'acolyte');
    await kit.app.locals.range!.lifecycle.launch(b.userId, 'r01', 'acolyte');
    const html = (await admin.get('/admin')).text;
    expect(html).toContain('data-testid="admin-states"');
    expect(html).toContain('data-testid="admin-near-capacity"');
    expect(html).toMatch(/data-testid="admin-live">2 <span class="stat-of">of 2 capacity</);
  });
});

describe('activity query helpers', () => {
  it('queryActivity matches username and team-name substrings literally (% is not a wildcard); countActivity counts', () => {
    const db = openDb(':memory:');
    migrate(db);
    logActivity(db, { event: 'team.join', userId: 1, username: 'alice', teamName: 'Phoenix%', now: 1 });
    logActivity(db, { event: 'team.join', userId: 2, username: 'bob', teamName: 'Phoenix', now: 2 });
    logActivity(db, { event: 'range.launch', userId: 1, username: 'alice', now: 3 });
    expect(queryActivity(db, { user: 'ali' }).map((r) => r.username)).toEqual(['alice', 'alice']);
    expect(queryActivity(db, { team: 'Phoenix%' }).map((r) => r.teamName)).toEqual(['Phoenix%']);
    expect(queryActivity(db, { event: 'range.' }).map((r) => r.event)).toEqual(['range.launch']);
    expect(countActivity(db, { event: 'team.' })).toBe(2);
    expect(countActivity(db, {})).toBe(3);
    db.close();
  });
});

describe('admin activity', () => {
  it('filters by event group and user text, and escapes every value', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    logActivity(db, { event: 'admin.mode', userId: 1, username: 'admin', labId: 'r01', detail: 'mode:team', ip: '203.0.113.1', now: 1000 });
    logActivity(db, { event: 'range.launch', userId: 2, username: 'alice', labId: 'r01', ip: '203.0.113.2', now: 2000 });
    logActivity(db, { event: 'range.exploit', userId: 2, username: 'alice', teamName: '<b>Crew</b>', labId: 'r02', level: 'acolyte', detail: 'points:150', ip: '203.0.113.2', now: 3000 });
    logActivity(db, { event: 'team.join', userId: 3, username: 'bob', teamName: 'Crew', now: 4000 });

    const html = (await admin.get('/admin/activity')).text;
    expect(html).toContain('data-testid="admin-activity-table"');
    expect(html).toContain('&lt;b&gt;Crew&lt;/b&gt;');
    expect(html).not.toContain('<b>Crew</b>');

    const range = (await admin.get('/admin/activity?event=range.')).text;
    expect(range).toContain('range.launch');
    expect(range).toContain('range.exploit');
    expect(range).not.toMatch(/<tr data-event="team.join"/);

    const alice = (await admin.get('/admin/activity?user=ali')).text;
    expect(alice).toContain('range.launch');
    expect(alice).toContain('range.exploit');
    expect(alice).not.toMatch(/<tr data-event="team.join"/);

    const future = (await admin.get('/admin/activity?event=range.&date=2026-11-20')).text;
    expect(future).toContain('No activity matches.');
  });

  it('paginates 50 rows per page with a total and prev/next links', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    for (let i = 1; i <= 55; i++) logActivity(db, { event: 'range.launch', userId: 1, username: 'admin', detail: `n:${i}`, now: i });
    const page1 = (await admin.get('/admin/activity?event=range.launch')).text;
    expect(page1).toContain('data-testid="admin-activity-count">55 rows<');
    expect((page1.match(/<td class="mono">range\.launch<\/td>/g) ?? []).length).toBe(50);
    expect(page1).toContain('data-testid="admin-next"');
    expect(page1).not.toContain('data-testid="admin-prev"');
    const page2 = (await admin.get('/admin/activity?event=range.launch&page=2')).text;
    expect((page2.match(/<td class="mono">range\.launch<\/td>/g) ?? []).length).toBe(5);
    expect(page2).toContain('data-testid="admin-prev"');
    expect(page2).not.toContain('data-testid="admin-next"');
  });
});

describe('admin lab modes', () => {
  it('toggling a lab to team mode logs admin.mode and flips the catalog badge and team leaderboard', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    const r = createTeam(db, 'Crew', a.userId, kit.clock.now());
    if (!r.ok) throw new Error('create');
    joinTeam(db, b.userId, r.team.joinCode, kit.clock.now());
    recordRangeSolve(db, a.userId, 'r01', 'templar', 150, kit.clock.now());

    expect((await a.agent.get('/')).text).not.toMatch(/data-lab="r01"[^>]*data-mode="team"/);
    expect(teamLeaderboard(db).map((t) => t.score)).toEqual([0]);

    const labsPage = (await admin.get('/admin/labs')).text;
    expect(labsPage).toContain('data-lab="r01" data-mode="individual"');
    const csrf = csrfOf(labsPage);

    expect((await admin.post('/admin/labs/r01/mode').type('form').send({ mode: 'team' })).status).toBe(403);
    expect((await admin.post('/admin/labs/r01/mode').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: csrf, mode: 'team' })).status).toBe(403);
    expect((await admin.post('/admin/labs/r01/mode').type('form').send({ _csrf: csrf, mode: 'insane' })).status).toBe(303);
    expect(labMode(db, 'r01')).toBe('individual');

    await admin.post('/admin/labs/r01/mode').type('form').send({ _csrf: csrf, mode: 'team' });
    expect(labMode(db, 'r01')).toBe('team');
    expect((await a.agent.get('/')).text).toMatch(/data-lab="r01"[^>]*data-mode="team"/);
    expect(teamLeaderboard(db)[0]).toMatchObject({ name: 'Crew', score: 150 });

    const modes = latestActivity(db, { event: 'admin.mode' });
    expect(modes.length).toBeGreaterThan(0);
    expect(modes[0]).toMatchObject({ labId: 'r01', detail: 'mode:team', username: 'admin' });
  });
});

describe('admin instance stop', () => {
  it('stops an active instance through the lifecycle, logs admin.stop and removes it; CSRF/Origin guards', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    const a = await player(kit.app, 'alice');
    const lc = kit.app.locals.range!.lifecycle;
    const launched = await lc.launch(a.userId, 'r01', 'templar');
    if (!launched.ok) throw new Error('launch');
    const id = launched.instance.id;

    const page = (await admin.get('/admin/instances')).text;
    expect(page).toContain(`data-instance="${id}"`);
    const csrf = csrfOf(page);

    expect((await admin.post(`/admin/instances/${id}/stop`).type('form').send({})).status).toBe(403);
    expect((await admin.post(`/admin/instances/${id}/stop`).set('Origin', 'https://evil.example').type('form').send({ _csrf: csrf })).status).toBe(403);
    expect((await admin.post(`/admin/instances/${id}/stop`).set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: csrf })).status).toBe(403);
    expect(lc.current(a.userId)).toBeDefined();

    const res = await admin.post(`/admin/instances/${id}/stop`).type('form').send({ _csrf: csrf });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/instances');
    expect(kit.warden.stopped).toContain(id);
    expect(lc.store.get(id)).toMatchObject({ state: 'stopped', reason: 'admin' });
    expect(lc.current(a.userId)).toBeUndefined();

    const stops = latestActivity(db, { event: 'admin.stop' });
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]).toMatchObject({ labId: 'r01', level: 'templar', username: 'admin', detail: `instance:${id}` });
  });
});

describe('admin teams', () => {
  it('creates and deletes teams, logs admin.team.create/delete, and shows the join code', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    const csrf = csrfOf((await admin.get('/admin/teams')).text);

    expect((await admin.post('/admin/teams/create').type('form').send({ name: 'Crew' })).status).toBe(403);
    expect((await admin.post('/admin/teams/create').type('form').send({ _csrf: csrf, name: 'Crew' })).status).toBe(303);

    const team = listTeams(db)[0];
    expect(team).toMatchObject({ name: 'Crew' });
    const page = (await admin.get('/admin/teams')).text;
    expect(page).toContain(`data-testid="admin-team-join-code">${team.joinCode}<`);
    expect(page).toContain('data-team="Crew"');

    const createLog = latestActivity(db, { event: 'admin.team.create' });
    expect(createLog[0]).toMatchObject({ teamName: 'Crew', username: 'admin' });

    expect((await admin.post(`/admin/teams/${team.id}/delete`).type('form').send({})).status).toBe(403);
    await admin.post(`/admin/teams/${team.id}/delete`).type('form').send({ _csrf: csrfOf(page) });
    expect(listTeams(db)).toEqual([]);
    const del = latestActivity(db, { event: 'admin.team.delete' });
    expect(del[0]).toMatchObject({ teamName: 'Crew', username: 'admin' });
  });

  it('removes a member, and an empty team is deleted', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const db = kit.app.locals.db;
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    const r = createTeam(db, 'Crew', a.userId, kit.clock.now());
    if (!r.ok) throw new Error('create');
    joinTeam(db, b.userId, r.team.joinCode, kit.clock.now());
    const page = (await admin.get('/admin/teams')).text;
    const csrf = csrfOf(page);
    await admin.post(`/admin/teams/${r.team.id}/members/${b.userId}/remove`).type('form').send({ _csrf: csrf });
    expect(listTeams(db)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(r.team.id)).toMatchObject({ c: 1 });
    // Removing the last member deletes the team (the leaveTeam rule).
    await admin.post(`/admin/teams/${r.team.id}/members/${a.userId}/remove`).type('form').send({ _csrf: csrf });
    expect(listTeams(db)).toEqual([]);
  });
});

describe('admin output hygiene', () => {
  it('no admin page or activity row renders a flag or secret', async () => {
    const kit = portalApp();
    const admin = await signInAdmin(kit.app);
    const a = await player(kit.app, 'alice');
    await kit.app.locals.range!.lifecycle.launch(a.userId, 'r01', 'acolyte');
    logActivity(kit.app.locals.db, { event: 'range.exploit', userId: a.userId, username: 'alice', labId: 'r01', level: 'acolyte', detail: 'points:100', now: kit.clock.now() });
    for (const path of ['/admin', '/admin/live', '/admin/activity', '/admin/instances', '/admin/teams', '/admin/labs']) {
      const html = (await admin.get(path)).text;
      expect(html, path).not.toMatch(/HVWA\{[a-z2-7]{26}\}/);
      expect(html, path).not.toContain('HVWA{');
    }
    for (const row of latestActivity(kit.app.locals.db, { limit: 1000 })) {
      expect(row.detail ?? '', 'activity detail').not.toContain('HVWA{');
    }
  });
});
