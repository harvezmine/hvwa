// The reaper (src/range/reaper.ts, spec range §5.7): every pass flushes last-seen, stops expired and idle instances,
// refreshes starting ones, fails crashed ones and removes containers no record owns. The compact POC has no queue, so a
// pass starts nothing new. On portal start, reconcile closes records without a container and removes unknown containers.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createLifecycle } from '../src/range/lifecycle.js';
import { reapOnce, reconcile, startReaper } from '../src/range/reaper.js';
import { DEFAULT_LIMITS, type RangeLimits } from '../src/range/types.js';
import { fakeWarden } from './support/fake-warden.js';
import { portalApp, RANGE_KEY, testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); vi.useRealTimers(); });
function make(limits: Partial<RangeLimits> = {}) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = 1_000_000;
  const warden = fakeWarden({ autoReady: true });
  const all = { ...DEFAULT_LIMITS, ...limits };
  const lc = createLifecycle({ db, warden, registry: testRegistry(), rangeKey: RANGE_KEY, limits: all, now: () => t, log: () => {} });
  const running = async (userId: number) => {
    const r = await lc.launch(userId, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    await lc.refresh(r.instance.id);
    return r.instance.id;
  };
  return { lc, warden, limits: all, now: () => t, advance: (ms: number) => { t += ms; }, running, pass: () => reapOnce(lc, warden, all, () => t) };
}

describe('reapOnce', () => {
  it('stops an expired instance (reason expired) and an idle one (reason idle); activity keeps one alive', async () => {
    const { lc, advance, running, pass } = make({ maxMs: 10_000, idleMs: 4_000 });
    const busy = await running(1);
    const idle = await running(2);
    advance(3_000);
    lc.touch(busy);
    advance(3_000);
    await pass();
    expect(lc.store.get(idle)).toMatchObject({ state: 'stopped', reason: 'idle' });
    expect(lc.store.get(busy)?.state).toBe('running');
    expect(lc.store.get(busy)?.lastSeenAt).not.toBeNull(); // flushed by the pass
    advance(5_000);
    lc.touch(busy);
    await pass();
    expect(lc.store.get(busy)).toMatchObject({ state: 'stopped', reason: 'expired' });
  });

  it('a crashed container (exited or gone) is failed "crashed"; a container no record owns is removed', async () => {
    const { lc, warden, running, pass } = make();
    const a = await running(1);
    const b = await running(2);
    warden.crash(a);
    warden.boxes.delete(b);
    warden.addOrphan('o'.repeat(26));
    await pass();
    expect(lc.store.get(a)).toMatchObject({ state: 'failed', reason: 'crashed' });
    expect(lc.store.get(b)).toMatchObject({ state: 'failed', reason: 'crashed' });
    expect(warden.stopped).toEqual(expect.arrayContaining([a, 'o'.repeat(26)]));
    expect(warden.boxes.size).toBe(0);
  });

  it('refreshes starting instances; it never starts anything from a queue (the POC has none)', async () => {
    const { lc, warden, pass } = make();
    const first = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance.id;
    const launched = warden.launched.length;
    await pass(); // refresh: first -> running (autoReady)
    expect(lc.store.get(first)?.state).toBe('running');
    expect(warden.launched).toHaveLength(launched);
    expect(lc.store.listByState('queued')).toEqual([]);
  });

  it('with the warden down a pass changes nothing and does not throw; the next pass works', async () => {
    const { lc, warden, running, pass } = make();
    const a = await running(1);
    warden.down = true;
    await expect(pass()).resolves.toBeUndefined();
    expect(lc.store.get(a)?.state).toBe('running');
    warden.down = false;
    warden.crash(a);
    await pass();
    expect(lc.store.get(a)?.state).toBe('failed');
  });
});

describe('reconcile (portal start)', () => {
  it('closes records without a container (lost) and leftover stopping ones; keeps a queued record; removes unknown containers', async () => {
    const { lc, warden, running, now } = make();
    const kept = await running(1);
    // The POC never writes 'queued', but an old database may hold one (the state stays in the schema): reconcile keeps it.
    lc.store.insert({ id: 'q'.repeat(26), userId: 2, labId: 'r01', level: 'acolyte', state: 'queued', flagHash: null, createdAt: now(), startedAt: null, expiresAt: null });
    lc.store.insert({ id: 'l'.repeat(26), userId: 3, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: null, createdAt: now(), startedAt: now(), expiresAt: now() + 1 });
    lc.store.insert({ id: 's'.repeat(26), userId: 4, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: null, createdAt: now(), startedAt: now(), expiresAt: now() + 1 });
    lc.store.update('s'.repeat(26), { state: 'stopping', reason: 'user' });
    warden.addOrphan('o'.repeat(26));
    await reconcile(lc, warden, now);
    expect(lc.store.get('l'.repeat(26))).toMatchObject({ state: 'stopped', reason: 'lost' });
    expect(lc.store.get('s'.repeat(26))).toMatchObject({ state: 'stopped', reason: 'user' });
    expect(lc.store.get(kept)?.state).toBe('running');
    expect(lc.store.get('q'.repeat(26))?.state).toBe('queued');
    expect(warden.stopped).toContain('o'.repeat(26));
  });
});

describe('startReaper', () => {
  it('runs the pass every interval, never two at once, until stopped', async () => {
    vi.useFakeTimers();
    let runs = 0;
    let release: () => void = () => {};
    const reaper = startReaper(() => { runs += 1; return new Promise<void>((r) => { release = r; }); }, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // the first pass is still running: skipped
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    reaper.stop();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(2);
  });

  it('RangePortal.start(): reconciles at once (an orphan is removed) and returns a stoppable reaper', async () => {
    const warden = fakeWarden({ autoReady: true });
    warden.addOrphan('o'.repeat(26));
    const { app } = portalApp({ warden });
    const reaper = app.locals.range!.start();
    await vi.waitFor(() => expect(warden.stopped).toContain('o'.repeat(26)));
    reaper.stop();
  });
});
