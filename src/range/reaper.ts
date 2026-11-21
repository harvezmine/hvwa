// src/range/reaper.ts — the range's housekeeping (spec range §5.7). Every 30 s one pass: flush last-seen, stop expired and
// idle instances, refresh the starting ones, fail the crashed ones (restart policy none: a dead container stays dead),
// and remove containers no record owns. The compact POC (plan amendment) has no queue, so a pass starts nothing new.
// On portal start, reconcile the records with the warden's list (hvwa.range=1): records without a container are closed,
// unknown containers removed.
import type { ListedInstance, WardenApi } from '../warden/protocol.js';
import type { Lifecycle } from './lifecycle.js';
import type { RangeLimits } from './types.js';

export const REAPER_INTERVAL_MS = 30_000;

/** Ids of the records that own a container: starting, running (queued ones have none yet). */
const owners = (lc: Lifecycle) => new Set(lc.store.listActive().filter((r) => r.state !== 'queued').map((r) => r.id));

export async function reapOnce(lc: Lifecycle, warden: WardenApi, limits: RangeLimits, now: () => number): Promise<void> {
  lc.flushLastSeen();
  for (const rec of lc.store.listActive()) {
    if (rec.state === 'starting') { await lc.refresh(rec.id); continue; }
    if (rec.state !== 'running') continue;
    const t = now();
    if (rec.expiresAt !== null && t >= rec.expiresAt) { await lc.stopInstance(rec.id, 'expired'); continue; }
    const seen = Math.max(rec.lastSeenAt ?? 0, rec.readyAt ?? rec.startedAt ?? rec.createdAt);
    if (t - seen >= limits.idleMs) await lc.stopInstance(rec.id, 'idle');
  }
  let listed: ListedInstance[];
  try {
    listed = await warden.list();
  } catch {
    return; // the warden is down: nothing is decided from a missing list
  }
  const containers = new Map(listed.map((c) => [c.instanceId, c]));
  for (const rec of lc.store.listByState('running')) {
    const c = containers.get(rec.id);
    if (c === undefined || c.state !== 'running') await lc.fail(rec.id, 'crashed');
  }
  const owned = owners(lc);
  for (const c of listed) {
    if (!owned.has(c.instanceId)) {
      try { await warden.stop(c.instanceId); } catch { /* the next pass retries */ }
    }
  }
}

export async function reconcile(lc: Lifecycle, warden: WardenApi, now: () => number): Promise<void> {
  const listed = await warden.list(); // throws while the warden is down: server.ts logs it; the reaper's passes catch up
  const present = new Set(listed.map((c) => c.instanceId));
  for (const rec of lc.store.listByState('stopping')) {
    lc.store.update(rec.id, { state: 'stopped', reason: rec.reason ?? 'interrupted', endedAt: now() });
  }
  for (const rec of lc.store.listActive()) {
    if (rec.state !== 'queued' && !present.has(rec.id)) lc.store.update(rec.id, { state: 'stopped', reason: 'lost', endedAt: now() });
  }
  const owned = owners(lc);
  for (const c of listed) if (!owned.has(c.instanceId)) await warden.stop(c.instanceId);
}

export interface Reaper { stop(): void }

/** Run `tick` every `intervalMs` (unref'd), skipping a beat while the previous pass still runs. */
export function startReaper(tick: () => Promise<void>, opts: { intervalMs?: number; onError?: (err: unknown) => void } = {}): Reaper {
  const onError = opts.onError ?? ((err: unknown) => console.error('HVWA range: reaper pass failed:', err));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch(onError).finally(() => { busy = false; });
  }, opts.intervalMs ?? REAPER_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
