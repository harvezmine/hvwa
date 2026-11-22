// The activity feed (src/range/activity.ts, migration 5): logActivity with bounded retention, the read helpers
// (latestActivity filters + pagination, liveExploitFeed), and the portal-only auth hook that logs register / login.
import { describe, it, expect, onTestFinished } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb, migrate } from '../src/db/index.js';
import { ACTIVITY_MAX_AGE_MS, latestActivity, liveExploitFeed, logActivity } from '../src/range/activity.js';
import { csrfOf, FAST_HASHER, TEST_SECRET } from './helpers.js';
import { portalApp, signInAs, ADMIN_PASSWORD } from './support/range.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

describe('activity logging helpers', () => {
  it('inserts rows and prunes anything older than 30 days on every write', () => {
    const db = fresh();
    logActivity(db, { event: 'range.launch', userId: 1, now: 1000 });
    expect(latestActivity(db).map((r) => r.event)).toEqual(['range.launch']);
    logActivity(db, { event: 'range.stop', userId: 1, now: 1000 + ACTIVITY_MAX_AGE_MS + 1 });
    expect(latestActivity(db).map((r) => r.event)).toEqual(['range.stop']);
  });

  it('latestActivity filters by exact event, event prefix, user, and paginates newest-first', () => {
    const db = fresh();
    logActivity(db, { event: 'range.launch', userId: 1, labId: 'r01', now: 1 });
    logActivity(db, { event: 'range.exploit', userId: 1, labId: 'r01', level: 'templar', detail: 'points:150', now: 2 });
    logActivity(db, { event: 'team.create', userId: 2, now: 3 });
    expect(latestActivity(db, { event: 'range.' }).map((r) => r.event)).toEqual(['range.exploit', 'range.launch']);
    expect(latestActivity(db, { event: 'range.exploit' }).map((r) => r.event)).toEqual(['range.exploit']);
    expect(latestActivity(db, { userId: 1 }).map((r) => r.event)).toEqual(['range.exploit', 'range.launch']);
    expect(latestActivity(db, { limit: 1, offset: 1 }).map((r) => r.event)).toEqual(['range.exploit']);
  });

  it('liveExploitFeed returns only accepted range.exploit rows, newest first', () => {
    const db = fresh();
    logActivity(db, { event: 'range.submit.wrong', userId: 1, labId: 'r01', now: 1 });
    logActivity(db, { event: 'range.exploit', userId: 1, labId: 'r01', level: 'acolyte', detail: 'points:100', now: 2 });
    logActivity(db, { event: 'team.join', userId: 1, now: 3 });
    const rows = liveExploitFeed(db);
    expect(rows.map((r) => r.event)).toEqual(['range.exploit']);
    expect(rows[0]).toMatchObject({ level: 'acolyte', detail: 'points:100', labId: 'r01' });
  });
});

describe('the auth activity hook (portal only)', () => {
  it('logs auth.register and auth.login, with the canonical username and no secret in detail', async () => {
    const kit = portalApp();
    const agent = request.agent(kit.app);
    const reg = await agent.get('/register');
    await agent.post('/register').type('form')
      .send({ _csrf: csrfOf(reg.text), username: '  Newbie  ', password: 'Player-Pass-1', confirm: 'Player-Pass-1' });
    await signInAs(kit.app, 'newbie', 'Player-Pass-1');
    const db = kit.app.locals.db;
    const rows = latestActivity(db, { event: 'auth.' });
    const events = rows.map((r) => r.event);
    expect(events).toContain('auth.register');
    expect(events).toContain('auth.login');
    const regRow = rows.find((r) => r.event === 'auth.register');
    expect(regRow).toMatchObject({ username: 'newbie' });
    expect(regRow?.detail).toBeNull();
  });

  it('standalone auth writes no activity (the hook is portal-only), so standalone behaviour is unchanged', async () => {
    const app = createApp({ flagSecret: TEST_SECRET, auth: { hasher: FAST_HASHER, initialPassword: ADMIN_PASSWORD } });
    onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed */ } });
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form')
      .send({ _csrf: csrfOf(page.text), username: 'admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(303);
    expect(latestActivity(app.locals.db, { event: 'auth.' })).toEqual([]);
  });
});
