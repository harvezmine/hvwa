// src/range/lifecycle.ts — the life of a range instance (spec range §5); compact POC (plan amendment): no FIFO queue and
// no Extend. Launch (one active per user; at capacity a `full` outcome), readiness, reset, stop and failure. The warden
// does the Docker work; this module owns the records (src/range/store.ts) and their states:
// starting → running → stopping → stopped, or failed (reason). One user's operations never interleave (a per-user
// promise chain), so "one active instance" holds under double clicks.
import type { DatabaseSync } from 'node:sqlite';
import type { Level } from '../core/levels.js';
import type { LabRegistry } from '../lab-registry.js';
import { WardenError, type InstanceHealth, type WardenApi } from '../warden/protocol.js';
import { flagHash, rangeFlag } from './flags.js';
import { newInstanceId } from './ids.js';
import { createInstanceStore, isActiveState, type InstanceRecord, type InstanceStore } from './store.js';
import type { RangeLimits } from './types.js';

/** Why an instance stopped (stored in `reason`); a failure stores the warden's or the health check's code instead. */
export const STOP_REASONS = Object.freeze(['user', 'replaced', 'idle', 'expired', 'lost', 'interrupted'] as const);
export type StopReason = (typeof STOP_REASONS)[number];

export interface LifecycleDeps {
  readonly db: DatabaseSync;
  readonly warden: WardenApi;
  readonly registry: LabRegistry;
  readonly rangeKey: string;
  readonly limits: RangeLimits;
  readonly now?: () => number;
  /** One line per problem (never a flag). Default console.warn. */
  readonly log?: (line: string) => void;
}

export type LaunchOutcome = { ok: true; instance: InstanceRecord } | { ok: false; error: 'unknown_lab' | 'bad_level' | 'full' };

export interface Lifecycle {
  readonly store: InstanceStore;
  /** The user's active instance (starting or running), if any. */
  current(userId: number): InstanceRecord | undefined;
  /** Stop the user's current instance, then start a new one of lab / level; at capacity, `full` and nothing starts. */
  launch(userId: number, labId: string, level: Level): Promise<LaunchOutcome>;
  /** Stop the user's active instance. */
  stop(userId: number, reason?: StopReason): Promise<void>;
  /** Stop one instance whoever owns it (the reaper). */
  stopInstance(instanceId: string, reason: StopReason): Promise<void>;
  /** Mark an active instance failed and remove its container (best effort). */
  fail(instanceId: string, reason: string): Promise<void>;
  /** A new instance of the same lab and level: a clean state and a new flag. */
  reset(userId: number): Promise<LaunchOutcome | { ok: false; error: 'none' }>;
  /** Ask the warden whether a starting instance is ready (or failed, or too slow to start). */
  refresh(instanceId: string): Promise<InstanceRecord | undefined>;
  /** A request reached the instance (forward-auth): kept in memory until flushLastSeen. */
  touch(instanceId: string): void;
  /** Write the remembered last-seen times (the reaper does it every 30 s). */
  flushLastSeen(): void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { warden, registry, rangeKey, limits } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const store = createInstanceStore(deps.db);
  const lastSeen = new Map<string, number>();
  const chains = new Map<number, Promise<unknown>>();

  /** Run `job` after every earlier job of this user. */
  function serial<T>(userId: number, job: () => Promise<T>): Promise<T> {
    const prev = chains.get(userId) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(userId, tail);
    void tail.then(() => { if (chains.get(userId) === tail) chains.delete(userId); });
    return run;
  }

  const codeOf = (err: unknown) => (err instanceof WardenError ? err.code : 'unavailable');

  async function start(rec: InstanceRecord): Promise<void> {
    const flag = rec.level === 'divine' ? undefined : rangeFlag(rangeKey, rec.id, rec.labId, rec.level);
    try {
      await warden.launch({
        labId: rec.labId, level: rec.level, instanceId: rec.id, ...(flag === undefined ? {} : { flag }),
        userId: rec.userId, expiresAt: rec.expiresAt ?? now() + limits.maxMs,
      });
    } catch (err) {
      store.update(rec.id, { state: 'failed', reason: codeOf(err), endedAt: now() });
      log(`range: launch of ${rec.id} failed (${codeOf(err)})`);
    }
  }

  async function stopRecord(rec: InstanceRecord, reason: StopReason): Promise<void> {
    store.update(rec.id, { state: 'stopping', reason });
    if (rec.state !== 'queued') {
      try { await warden.stop(rec.id); } catch (err) { log(`range: stop of ${rec.id} failed (${codeOf(err)}); the reaper retries`); }
    }
    store.update(rec.id, { state: 'stopped', endedAt: now() });
    lastSeen.delete(rec.id);
  }

  const lc: Lifecycle = {
    store,
    current: (userId) => store.activeFor(userId),

    launch: (userId, labId, level) => serial(userId, async (): Promise<LaunchOutcome> => {
      const lab = registry.get(labId);
      if (!lab) return { ok: false, error: 'unknown_lab' };
      if (!lab.levels.includes(level)) return { ok: false, error: 'bad_level' };
      const prev = store.activeFor(userId);
      // The compact POC has no queue: at capacity the launch is refused. Replacing the user's own instance frees its
      // own slot, so a relaunch still succeeds at capacity (if the range is not full besides it).
      const live = store.countLive() - (prev && prev.state !== 'queued' ? 1 : 0);
      if (live >= limits.capacity) return { ok: false, error: 'full' };
      if (prev) await stopRecord(prev, 'replaced');
      const id = newInstanceId();
      const t = now();
      const hash = level === 'divine' ? null : flagHash(rangeFlag(rangeKey, id, labId, level));
      store.insert({ id, userId, labId, level, state: 'starting', flagHash: hash, createdAt: t, startedAt: t, expiresAt: t + limits.maxMs });
      await start(store.get(id) as InstanceRecord);
      return { ok: true, instance: store.get(id) as InstanceRecord };
    }),

    async stop(userId, reason = 'user') {
      await serial(userId, async () => {
        const rec = store.activeFor(userId);
        if (rec) await stopRecord(rec, reason);
      });
    },

    async stopInstance(id, reason) {
      const rec = store.get(id);
      if (!rec || !isActiveState(rec.state)) return;
      await serial(rec.userId, async () => {
        const again = store.get(id);
        if (again && isActiveState(again.state)) await stopRecord(again, reason);
      });
    },

    async fail(id, reason) {
      const rec = store.get(id);
      if (!rec || !isActiveState(rec.state)) return;
      store.update(id, { state: 'failed', reason, endedAt: now() });
      lastSeen.delete(id);
      try { await warden.stop(id); } catch (err) { log(`range: removing failed ${id} failed (${codeOf(err)}); the reaper retries`); }
    },

    async reset(userId) {
      const rec = store.activeFor(userId);
      if (!rec) return { ok: false, error: 'none' };
      return lc.launch(userId, rec.labId, rec.level);
    },

    async refresh(id) {
      const rec = store.get(id);
      if (!rec || rec.state !== 'starting') return rec;
      let health: InstanceHealth;
      try { health = await warden.health(id); } catch { return rec; }
      const timedOut = now() - (rec.startedAt ?? rec.createdAt) > limits.startTimeoutMs;
      if (health.status === 'ready') store.update(id, { state: 'running', readyAt: now() });
      else if (health.status !== 'starting') await lc.fail(id, health.reason ?? health.status);
      else if (timedOut) await lc.fail(id, 'start_timeout');
      return store.get(id);
    },

    touch(id) { lastSeen.set(id, now()); },
    flushLastSeen() {
      for (const [id, t] of lastSeen) store.update(id, { lastSeenAt: t });
      lastSeen.clear();
    },
  };
  return lc;
}
