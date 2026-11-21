// The range_instances table behind the lifecycle (src/range/store.ts): records, one active per user (the database
// enforces it too), the live count, the FIFO queue methods and the 24-hour flag lookup by hash. The compact POC never
// writes 'queued' (no FIFO queue, amendment), but the store keeps the queries for a queue that could return.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createInstanceStore, type NewInstance } from '../src/range/store.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function store() {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  return createInstanceStore(db);
}
const id = (c: string) => c.repeat(26);
const rec = (over: Partial<NewInstance> = {}): NewInstance => ({
  id: id('a'), userId: 1, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: 'h1', createdAt: 100, startedAt: 100, expiresAt: 1000, ...over,
});

describe('createInstanceStore', () => {
  it('inserts, reads back and patches a record; unknown ids are undefined', () => {
    const s = store();
    s.insert(rec());
    expect(s.get(id('a'))).toEqual({
      id: id('a'), userId: 1, labId: 'r01', level: 'acolyte', state: 'starting', reason: null, flagHash: 'h1',
      createdAt: 100, startedAt: 100, readyAt: null, expiresAt: 1000, lastSeenAt: null, endedAt: null,
    });
    s.update(id('a'), { state: 'running', readyAt: 150 });
    expect(s.get(id('a'))).toMatchObject({ state: 'running', readyAt: 150 });
    s.update(id('a'), {});
    expect(s.get(id('b'))).toBeUndefined();
  });

  it('one active instance per user, in the database too; stopped and failed ones do not count', () => {
    const s = store();
    s.insert(rec());
    expect(() => s.insert(rec({ id: id('b') }))).toThrow(/UNIQUE/);
    s.update(id('a'), { state: 'stopped', endedAt: 200 });
    s.insert(rec({ id: id('b') }));
    expect(s.activeFor(1)?.id).toBe(id('b'));
    expect(s.activeFor(2)).toBeUndefined();
  });

  it('counts live instances (starting + running), lists the queue oldest first, gives 1-based positions', () => {
    const s = store();
    s.insert(rec({ id: id('a'), userId: 1 }));
    s.insert(rec({ id: id('b'), userId: 2, state: 'queued', startedAt: null, expiresAt: null, createdAt: 300 }));
    s.insert(rec({ id: id('c'), userId: 3, state: 'queued', startedAt: null, expiresAt: null, createdAt: 200 }));
    expect(s.countLive()).toBe(1);
    expect(s.queued().map((r) => r.id)).toEqual([id('c'), id('b')]);
    expect([s.queuePosition(id('c')), s.queuePosition(id('b')), s.queuePosition(id('a'))]).toEqual([1, 2, 0]);
    expect(s.listActive().map((r) => r.id)).toEqual([id('a'), id('c'), id('b')]);
    expect(s.listByState('queued')).toHaveLength(2);
  });

  it('levelForFlag: only this user\'s instances of this lab, created inside the window', () => {
    const s = store();
    s.insert(rec({ id: id('a'), userId: 1, level: 'templar', flagHash: 'H', createdAt: 5000 }));
    expect(s.levelForFlag(1, 'r01', 'H', 1000)).toBe('templar');
    expect(s.levelForFlag(2, 'r01', 'H', 1000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r02', 'H', 1000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r01', 'H', 6000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r01', 'other', 1000)).toBeUndefined();
  });

  it('latestFor: the newest record of a user for a lab and level (the panel shows a recent failure)', () => {
    const s = store();
    s.insert(rec({ id: id('a'), createdAt: 1 }));
    s.update(id('a'), { state: 'failed', reason: 'unhealthy', endedAt: 2 });
    s.insert(rec({ id: id('b'), createdAt: 3, level: 'templar' }));
    expect(s.latestFor(1, 'r01', 'acolyte')).toMatchObject({ id: id('a'), state: 'failed', reason: 'unhealthy' });
    expect(s.latestFor(1, 'r01', 'templar')?.id).toBe(id('b'));
    expect(s.latestFor(1, 'r02', 'acolyte')).toBeUndefined();
  });
});
