// The instance lifecycle (src/range/lifecycle.ts, spec range §5): launch with the derived flag, one active instance per
// user, global capacity answering `full` (compact POC: no queue and no Extend), readiness from the warden's health,
// reset with a new flag, stop; and failures with a reason. Unit level: the store and a fake warden, on a fake clock.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createLifecycle } from '../src/range/lifecycle.js';
import { flagHash, rangeFlag } from '../src/range/flags.js';
import { DEFAULT_LIMITS, type RangeLimits } from '../src/range/types.js';
import { fakeWarden, type FakeWarden } from './support/fake-warden.js';
import { RANGE_KEY, testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function make(limits: Partial<RangeLimits> = {}, warden: FakeWarden = fakeWarden()) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = 1_000_000;
  const lc = createLifecycle({
    db, warden, registry: testRegistry(), rangeKey: RANGE_KEY, limits: { ...DEFAULT_LIMITS, ...limits }, now: () => t, log: () => {},
  });
  return { lc, warden, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('launch', () => {
  it('starts an instance: the warden gets the derived flag and the expiry; the record keeps only the flag\'s hash', async () => {
    const { lc, warden, now } = make();
    const r = await lc.launch(7, 'r01', 'templar');
    expect(r.ok).toBe(true);
    const rec = (r as { ok: true; instance: { id: string } }).instance;
    const flag = rangeFlag(RANGE_KEY, rec.id, 'r01', 'templar');
    expect(warden.launched).toEqual([{ labId: 'r01', level: 'templar', instanceId: rec.id, flag, userId: 7, expiresAt: now() + DEFAULT_LIMITS.maxMs }]);
    expect(lc.store.get(rec.id)).toMatchObject({ state: 'starting', flagHash: flagHash(flag), startedAt: now(), expiresAt: now() + DEFAULT_LIMITS.maxMs });
    expect(JSON.stringify(lc.store.get(rec.id))).not.toContain(flag);
  });

  it('Divine is launched without a flag and records no hash', async () => {
    const { lc, warden } = make();
    const r = await lc.launch(7, 'r01', 'divine');
    expect(warden.launched[0]).not.toHaveProperty('flag');
    expect(lc.store.get((r as { ok: true; instance: { id: string } }).instance.id)?.flagHash).toBeNull();
  });

  it('refuses an unknown lab or a level the lab does not have, launching nothing', async () => {
    const { lc, warden } = make();
    expect(await lc.launch(7, 'r99', 'acolyte')).toEqual({ ok: false, error: 'unknown_lab' });
    expect(await lc.launch(7, 'r02', 'templar')).toEqual({ ok: false, error: 'bad_level' });
    expect(warden.launched).toEqual([]);
  });

  it('one active per user: a second launch stops the first (reason "replaced"); concurrent launches still leave one', async () => {
    const { lc, warden } = make();
    const first = await lc.launch(7, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    const second = await lc.launch(7, 'r02', 'acolyte') as { ok: true; instance: { id: string } };
    expect(warden.stopped).toEqual([first.instance.id]);
    expect(lc.store.get(first.instance.id)).toMatchObject({ state: 'stopped', reason: 'replaced' });
    expect(lc.current(7)?.id).toBe(second.instance.id);
    await Promise.all([lc.launch(8, 'r01', 'acolyte'), lc.launch(8, 'r01', 'templar'), lc.launch(8, 'r02', 'acolyte')]);
    expect(lc.store.listActive().filter((r) => r.userId === 8)).toHaveLength(1);
  });

  it('a warden failure is "failed" with its code, and the slot is free again', async () => {
    const { lc, warden } = make({ capacity: 1 });
    warden.failNextLaunch('docker');
    const r = await lc.launch(7, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    expect(lc.store.get(r.instance.id)).toMatchObject({ state: 'failed', reason: 'docker' });
    expect(lc.current(7)).toBeUndefined();
    expect((await lc.launch(8, 'r01', 'acolyte') as { ok: true; instance: { state: string } }).instance.state).toBe('starting');
  });
});

describe('capacity (no queue)', () => {
  it('beyond capacity a launch answers "full" and launches nothing; a freed slot accepts it', async () => {
    const { lc, warden } = make({ capacity: 2 });
    await lc.launch(1, 'r01', 'acolyte');
    await lc.launch(2, 'r01', 'acolyte');
    expect(await lc.launch(3, 'r01', 'acolyte')).toEqual({ ok: false, error: 'full' });
    expect(lc.store.activeFor(3)).toBeUndefined();
    expect(lc.store.listByState('queued')).toEqual([]);
    expect(warden.launched).toHaveLength(2);
    await lc.stop(1);
    expect((await lc.launch(3, 'r01', 'acolyte') as { ok: true; instance: { state: string } }).instance.state).toBe('starting');
    expect(warden.launched).toHaveLength(3);
  });

  it('replacing your own instance frees its own slot, so a relaunch at capacity still starts', async () => {
    const { lc, warden } = make({ capacity: 1 });
    const first = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    expect((await lc.launch(1, 'r01', 'templar') as { ok: true; instance: { id: string } }).instance.id).not.toBe(first.id);
    expect(lc.store.get(first.id)).toMatchObject({ state: 'stopped', reason: 'replaced' });
    expect(warden.launched).toHaveLength(2);
  });

  it('a relaunch reserves its own slot before stopping the old container, so a concurrent user cannot take it', async () => {
    const base = fakeWarden({ autoReady: true });
    const realStop = base.stop.bind(base);
    let gate: Promise<void> | undefined;
    let release!: () => void;
    let signalStop!: () => void;
    const stopped = new Promise<void>((r) => { signalStop = r; });
    base.stop = async (id: string) => { if (gate) { signalStop(); await gate; } return realStop(id); };
    const { lc } = make({ capacity: 2 }, base);
    await lc.launch(1, 'r01', 'acolyte'); // user 1's instance
    await lc.launch(2, 'r01', 'acolyte'); // user 2's instance: the range is now full

    gate = new Promise<void>((r) => { release = r; });
    const relaunch = lc.launch(1, 'r02', 'acolyte'); // reserves its new slot, then parks stopping the old container
    await stopped; // user 1's replacement is already reserved
    const third = await lc.launch(3, 'r01', 'acolyte'); // the reserved slot is not free to take
    expect(third).toEqual({ ok: false, error: 'full' });
    release();
    const r = await relaunch;
    expect(r.ok).toBe(true);
    expect(lc.store.countLive()).toBe(2);
    expect(lc.store.activeFor(1)?.labId).toBe('r02');
    expect(lc.store.listActive()).toHaveLength(2);
  });

  it('when the range is already over capacity besides the player\'s own slot, a relaunch is "full" and destroys nothing', async () => {
    const db = openDb(':memory:');
    migrate(db);
    dbs.push(db);
    const warden = fakeWarden({ autoReady: true });
    let t = 1_000_000;
    const makeWith = (capacity: number) => createLifecycle({
      db, warden, registry: testRegistry(), rangeKey: RANGE_KEY, limits: { ...DEFAULT_LIMITS, capacity }, now: () => t, log: () => {},
    });
    const wide = makeWith(3);
    await wide.launch(1, 'r01', 'acolyte');
    await wide.launch(2, 'r01', 'acolyte');
    await wide.launch(3, 'r01', 'acolyte');
    const before = wide.current(1)!.id;
    const narrow = makeWith(2); // e.g. the operator lowered the capacity while the instance ran
    expect(await narrow.launch(1, 'r01', 'templar')).toEqual({ ok: false, error: 'full' });
    expect(wide.current(1)?.id).toBe(before);
    expect(wide.store.get(before)?.state).toBe('starting');
    expect(warden.stopped).not.toContain(before);
  });
});

describe('readiness (refresh)', () => {
  it('starting -> running when the warden says ready; failed with the health reason otherwise (and the container removed)', async () => {
    const { lc, warden } = make();
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    expect((await lc.refresh(a.id))?.state).toBe('starting');
    warden.setHealth(a.id, { status: 'ready' });
    expect(await lc.refresh(a.id)).toMatchObject({ state: 'running' });
    const b = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.setHealth(b.id, { status: 'failed', reason: 'unhealthy' });
    expect(await lc.refresh(b.id)).toMatchObject({ state: 'failed', reason: 'unhealthy' });
    expect(warden.stopped).toContain(b.id);
  });

  it('a start slower than startTimeoutMs fails as start_timeout; a vanished container as missing; warden errors change nothing', async () => {
    const { lc, warden, advance } = make({ startTimeoutMs: 5000 });
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.down = true;
    expect((await lc.refresh(a.id))?.state).toBe('starting');
    warden.down = false;
    advance(5001);
    expect(await lc.refresh(a.id)).toMatchObject({ state: 'failed', reason: 'start_timeout' });
    const b = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.boxes.delete(b.id);
    expect(await lc.refresh(b.id)).toMatchObject({ state: 'failed', reason: 'missing' });
  });

  it('an unreachable warden still times out a starting instance once startTimeoutMs has passed', async () => {
    const { lc, warden, advance } = make({ startTimeoutMs: 5000 });
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.down = true; // health (and the cleanup stop) always throw
    advance(5000);
    expect(await lc.refresh(a.id)).toMatchObject({ state: 'failed', reason: 'start_timeout' });
    expect(lc.store.get(a.id)?.state).toBe('failed');
  });
});

describe('reset and stop', () => {
  it('reset: a new instance of the same lab and level with a new flag; the old one is stopped', async () => {
    const { lc, warden } = make();
    expect(await lc.reset(1)).toEqual({ ok: false, error: 'none' });
    const a = (await lc.launch(1, 'r01', 'templar') as { ok: true; instance: { id: string } }).instance;
    const b = (await lc.reset(1) as { ok: true; instance: { id: string; labId: string; level: string } }).instance;
    expect(b.id).not.toBe(a.id);
    expect([b.labId, b.level]).toEqual(['r01', 'templar']);
    expect(warden.launched[1].flag).not.toBe(warden.launched[0].flag);
    expect(lc.store.get(a.id)).toMatchObject({ state: 'stopped', reason: 'replaced' });
  });

  it('stopInstance (reaper) stops whoever owns it; touch + flushLastSeen write last_seen_at', async () => {
    const { lc, now } = make();
    const a = (await lc.launch(5, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    lc.touch(a.id);
    expect(lc.store.get(a.id)?.lastSeenAt).toBeNull();
    lc.flushLastSeen();
    expect(lc.store.get(a.id)?.lastSeenAt).toBe(now());
    await lc.stopInstance(a.id, 'expired');
    expect(lc.store.get(a.id)).toMatchObject({ state: 'stopped', reason: 'expired' });
    await lc.stopInstance(a.id, 'expired'); // already stopped: nothing happens
  });
});
