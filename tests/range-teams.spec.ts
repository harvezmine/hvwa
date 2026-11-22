// Teams (src/range/teams.ts, modes.ts): the service (create/join/leave/members), team-mode scoring (best level per
// team-mode lab, a lab counted once across members, disabled users excluded, individual labs ignored), the team
// leaderboard, the team page (CSRF on every POST) and the TEAM badge on catalog and lab pages.
import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { setLabMode } from '../src/range/modes.js';
import { recordRangeSolve } from '../src/range/progress.js';
import {
  MAX_TEAMS, JOIN_CODE_RE, createTeam, joinTeam, leaveTeam, teamOfUser, teamMembers, teamScore, teamLeaderboard,
} from '../src/range/teams.js';
import { csrfOf } from './helpers.js';
import { portalApp, player } from './support/range.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

/** Insert a user (role player by default) and return its id. */
function addUser(db: DatabaseSync, username: string, disabled = 0): number {
  const info = db.prepare('INSERT INTO users (username, password_hash, role, created_at, disabled, is_default, failures, locked_until, changed_at) VALUES (?, \'h\', \'player\', 1, ?, 0, 0, 0, 1)').run(username, disabled);
  return Number(info.lastInsertRowid);
}

describe('team service', () => {
  it('creates a team with a trimmed 3-32 name, an 8-char base32 join code, and the creator as first member', () => {
    const db = fresh();
    const me = addUser(db, 'alice');
    const r = createTeam(db, '  Phoenix Crew  ', me, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.team.name).toBe('Phoenix Crew');
    expect(r.team.joinCode).toMatch(JOIN_CODE_RE);
    expect(teamOfUser(db, me)).toMatchObject({ id: r.team.id, name: 'Phoenix Crew' });
    expect(teamMembers(db, r.team.id)).toEqual([{ userId: me, username: 'alice', joinedAt: 100 }]);
  });

  it('rejects names outside 3-32 and duplicate names whatever their case; caps at MAX_TEAMS', () => {
    const db = fresh();
    const alice = addUser(db, 'alice');
    expect(createTeam(db, 'ab', alice, 1)).toEqual({ ok: false, error: 'name' });
    expect(createTeam(db, 'x'.repeat(33), alice, 1)).toEqual({ ok: false, error: 'name' });
    expect(createTeam(db, 'Crew', alice, 1).ok).toBe(true);
    expect(createTeam(db, 'crew', alice, 1)).toEqual({ ok: false, error: 'duplicate' });
    for (let i = 2; i <= MAX_TEAMS; i++) {
      expect(createTeam(db, `Team ${i}`, addUser(db, `u${i}`), 1).ok).toBe(true);
    }
    expect(createTeam(db, 'Overflow', addUser(db, 'spare'), 1)).toEqual({ ok: false, error: 'full' });
  });

  it('join is by code (case-insensitive input), rejects a bad code and a second team; leave removes the last member and the team', () => {
    const db = fresh();
    const a = addUser(db, 'alice');
    const b = addUser(db, 'bob');
    const c = addUser(db, 'carol');
    const r = createTeam(db, 'Crew', a, 1);
    if (!r.ok) throw new Error('create');
    expect(joinTeam(db, b, r.team.joinCode.toLowerCase(), 2).ok).toBe(true);
    expect(joinTeam(db, b, 'ZZZZZZZZ', 2)).toEqual({ ok: false, error: 'code' });
    expect(joinTeam(db, c, r.team.joinCode, 3).ok).toBe(true);
    expect(joinTeam(db, c, r.team.joinCode, 3)).toEqual({ ok: false, error: 'already' }); // one team per user
    expect(teamMembers(db, r.team.id).map((m) => m.username)).toEqual(['alice', 'bob', 'carol']);
    // A non-last member leaving keeps the team.
    expect(leaveTeam(db, b)).toEqual({ ok: true, left: true });
    expect(teamOfUser(db, b)).toBeUndefined();
    expect(teamMembers(db, r.team.id).map((m) => m.username)).toEqual(['alice', 'carol']);
    // The last two leaving delete the team (documented choice: no empty team shells).
    expect(leaveTeam(db, a).left).toBe(true);
    expect(leaveTeam(db, c).left).toBe(true);
    expect(teamOfUser(db, a)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS c FROM teams').get()).toMatchObject({ c: 0 });
  });
});

describe('team scoring (team mode only)', () => {
  it('sums the best level per team-mode lab, counts a lab once across members, and excludes disabled users and individual labs', () => {
    const db = fresh();
    const alice = addUser(db, 'alice');
    const bob = addUser(db, 'bob');
    const carol = addUser(db, 'carol', 1); // disabled
    const r = createTeam(db, 'Crew', alice, 1);
    if (!r.ok) throw new Error('create');
    joinTeam(db, bob, r.team.joinCode, 1);
    joinTeam(db, carol, r.team.joinCode, 1);
    setLabMode(db, 'r01', 'team', undefined, 1);
    setLabMode(db, 'r02', 'team', undefined, 1);
    // r03 stays individual (no lab_modes row).
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 10);
    recordRangeSolve(db, bob, 'r01', 'templar', 150, 20);   // best r01 = 150
    recordRangeSolve(db, carol, 'r01', 'inquisitor', 999, 30); // disabled -> ignored
    recordRangeSolve(db, alice, 'r02', 'acolyte', 200, 40);
    recordRangeSolve(db, bob, 'r02', 'acolyte', 200, 50);   // a level solved by several members counts once
    recordRangeSolve(db, alice, 'r03', 'inquisitor', 400, 60); // individual -> ignored
    expect(teamScore(db, r.team.id)).toBe(350); // 150 + 200
  });

  it('a lab solved by several members never double-counts', () => {
    const db = fresh();
    const a = addUser(db, 'alice');
    const b = addUser(db, 'bob');
    const r = createTeam(db, 'Crew', a, 1);
    if (!r.ok) throw new Error('create');
    joinTeam(db, b, r.team.joinCode, 1);
    setLabMode(db, 'r01', 'team', undefined, 1);
    recordRangeSolve(db, a, 'r01', 'templar', 150, 10);
    recordRangeSolve(db, b, 'r01', 'templar', 150, 20);
    recordRangeSolve(db, b, 'r01', 'inquisitor', 200, 30); // b upgrades: the team's best is 200, not 150+200
    expect(teamScore(db, r.team.id)).toBe(200);
  });

  it('the team leaderboard ranks by score, breaks ties by the earlier last solve, and counts members', () => {
    const db = fresh();
    const a = addUser(db, 'alice');
    const b = addUser(db, 'bob');
    const c = addUser(db, 'carol');
    const alpha = createTeam(db, 'Alpha', a, 1);
    const beta = createTeam(db, 'Beta', c, 1);
    if (!alpha.ok || !beta.ok) throw new Error('create');
    joinTeam(db, b, alpha.team.joinCode, 1); // Alpha: 2 members
    setLabMode(db, 'r01', 'team', undefined, 1);
    recordRangeSolve(db, a, 'r01', 'inquisitor', 300, 100); // Alpha last solve later
    recordRangeSolve(db, c, 'r01', 'inquisitor', 300, 50);  // Beta last solve earlier
    const rows = teamLeaderboard(db);
    expect(rows.map((r) => r.name)).toEqual(['Beta', 'Alpha']);
    expect(rows[0]).toMatchObject({ score: 300, members: 1, solved: 1, teamId: beta.team.id });
    expect(rows[1]).toMatchObject({ score: 300, members: 2, solved: 1, teamId: alpha.team.id });
  });
});

describe('team page and mode badge (portal HTTP)', () => {
  it('a player with no team sees create/join forms; POST needs the account CSRF token and creates the team', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    const page = (await agent.get('/team')).text;
    expect(page).toContain('data-testid="team-create-form"');
    expect(page).toContain('data-testid="team-join-form"');
    expect(page).toContain('data-testid="nav-team"');
    // No CSRF -> refused.
    expect((await agent.post('/team/create').type('form').send({ name: 'Crew' })).status).toBe(403);
    await agent.post('/team/create').type('form').send({ _csrf: csrfOf(page), name: 'Crew' });
    const sheet = (await agent.get('/team')).text;
    expect(sheet).toContain('data-testid="team-sheet"');
    expect(sheet).toContain('data-testid="team-name">Crew<');
    expect(sheet).toMatch(/data-testid="team-join-code">[A-Z2-7]{8}</);
    expect(sheet).toContain('data-user="alice"');
  });

  it('a second player joins by code (case-insensitive); leaving is CSRF-guarded and the last member deletes the team', async () => {
    const kit = portalApp();
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    await a.agent.post('/team/create').type('form').send({ _csrf: csrfOf((await a.agent.get('/team')).text), name: 'Crew' });
    const code = /data-testid="team-join-code">([A-Z2-7]{8})</.exec((await a.agent.get('/team')).text)?.[1];
    expect(code).toBeDefined();
    await b.agent.post('/team/join').type('form').send({ _csrf: csrfOf((await b.agent.get('/team')).text), code: code!.toLowerCase() });
    const sheet = (await b.agent.get('/team')).text;
    expect(sheet).toContain('data-user="alice"');
    expect(sheet).toContain('data-user="bob"');
    // CSRF on leave.
    expect((await a.agent.post('/team/leave').type('form').send({})).status).toBe(403);
    await b.agent.post('/team/leave').type('form').send({ _csrf: csrfOf((await b.agent.get('/team')).text) });
    await a.agent.post('/team/leave').type('form').send({ _csrf: csrfOf((await a.agent.get('/team')).text) });
    expect((await a.agent.get('/team')).text).toContain('data-testid="team-create-form"');
    expect(kit.app.locals.db.prepare('SELECT COUNT(*) AS c FROM teams').get()).toMatchObject({ c: 0 });
  });

  it('shows the TEAM badge and data-mode on team-mode labs, none on individual labs (catalog and lab page)', async () => {
    const kit = portalApp();
    setLabMode(kit.app.locals.db, 'r01', 'team', undefined, kit.clock.now());
    const { agent } = await player(kit.app, 'alice');
    const catalog = (await agent.get('/')).text;
    expect(catalog).toMatch(/data-lab="r01"[^>]*data-mode="team"/);
    expect(catalog).toContain('TEAM');
    expect(catalog).not.toMatch(/data-lab="r02"[^>]*data-mode="team"/);
    const lab = (await agent.get('/labs/r01')).text;
    expect(lab).toContain('data-mode="team"');
    expect(lab).toContain('TEAM');
    expect((await agent.get('/labs/r02')).text).not.toContain('data-mode="team"');
  });

  it('the leaderboard teams tab shows rank, team, score, solved, members and last solve; pins the viewer team', async () => {
    const kit = portalApp();
    const a = await player(kit.app, 'alice');
    const b = await player(kit.app, 'bob');
    const db = kit.app.locals.db;
    setLabMode(db, 'r01', 'team', undefined, kit.clock.now());
    const r = createTeam(db, 'Crew', a.userId, kit.clock.now());
    if (!r.ok) throw new Error('create');
    joinTeam(db, b.userId, r.team.joinCode, kit.clock.now());
    recordRangeSolve(db, a.userId, 'r01', 'templar', 150, kit.clock.now());
    const html = (await a.agent.get('/leaderboard?board=teams')).text;
    expect(html).toContain('data-testid="tab-teams"');
    expect(html).toMatch(/data-testid="tab-teams"[^>]*aria-current="page"/);
    expect(html).toMatch(/data-rank="1" data-team="Crew"/);
    expect(html).toContain('data-team="Crew"');
    expect(html).toContain('Members');
    expect(html).toContain('Last solve');
    expect(html).toContain('(your team)');
  });
});
