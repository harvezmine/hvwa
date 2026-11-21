// src/range/store.ts — the range_instances table (migration 4): one row per instance, its flag kept as a SHA-256.
// Only the lifecycle (src/range/lifecycle.ts) writes it; the gate, forward-auth, flag submission and the panels read it.
// The compact POC (plan amendment) never writes 'queued'; the state and the queue queries stay for the record.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isLevel, type Level } from '../core/levels.js';

export const INSTANCE_STATES = Object.freeze(['queued', 'starting', 'running', 'stopping', 'stopped', 'failed'] as const);
export type InstanceState = (typeof INSTANCE_STATES)[number];
/** States that hold the user's one slot (the unique index range_instances_one_active). */
export const ACTIVE_STATES: readonly InstanceState[] = Object.freeze(['queued', 'starting', 'running']);
export const isActiveState = (s: InstanceState) => ACTIVE_STATES.includes(s);

export interface InstanceRecord {
  readonly id: string;
  readonly userId: number;
  readonly labId: string;
  readonly level: Level;
  readonly state: InstanceState;
  readonly reason: string | null;
  readonly flagHash: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
  readonly expiresAt: number | null;
  readonly lastSeenAt: number | null;
  readonly endedAt: number | null;
}

export interface NewInstance {
  readonly id: string;
  readonly userId: number;
  readonly labId: string;
  readonly level: Level;
  readonly state: 'queued' | 'starting';
  readonly flagHash: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly expiresAt: number | null;
}

export type InstancePatch = Partial<Pick<InstanceRecord, 'state' | 'reason' | 'startedAt' | 'readyAt' | 'expiresAt' | 'lastSeenAt' | 'endedAt'>>;

export interface InstanceStore {
  insert(rec: NewInstance): void;
  get(id: string): InstanceRecord | undefined;
  activeFor(userId: number): InstanceRecord | undefined;
  update(id: string, patch: InstancePatch): void;
  /** queued, starting and running, oldest first. */
  listActive(): InstanceRecord[];
  listByState(state: InstanceState): InstanceRecord[];
  /** starting + running: what counts against the capacity. */
  countLive(): number;
  /** The FIFO queue, oldest first (empty in the compact POC). */
  queued(): InstanceRecord[];
  /** 1-based position in the queue; 0 when not queued. */
  queuePosition(id: string): number;
  /** The level of one of `userId`'s instances of `labId` created at or after `since` whose flag hashes to `hash`. */
  levelForFlag(userId: number, labId: string, hash: string, since: number): Level | undefined;
  /** The newest record of this user for this lab and level, any state. */
  latestFor(userId: number, labId: string, level: Level): InstanceRecord | undefined;
}

interface Row {
  id: string; user_id: number; lab_id: string; level: string; state: string; reason: string | null; flag_hash: string | null;
  created_at: number; started_at: number | null; ready_at: number | null; expires_at: number | null; last_seen_at: number | null;
  ended_at: number | null;
}

const COLUMNS: Readonly<Record<keyof InstancePatch, string>> = Object.freeze({
  state: 'state', reason: 'reason', startedAt: 'started_at', readyAt: 'ready_at', expiresAt: 'expires_at', lastSeenAt: 'last_seen_at', endedAt: 'ended_at',
});
const SELECT = `SELECT id, user_id, lab_id, level, state, reason, flag_hash, created_at, started_at, ready_at, expires_at, last_seen_at,
  ended_at FROM range_instances`;
const num = (v: number | null) => (v === null ? null : Number(v));

function toRecord(r: Row): InstanceRecord {
  if (!isLevel(r.level)) throw new Error(`range_instances ${r.id}: bad level ${r.level}`);
  return {
    id: r.id, userId: Number(r.user_id), labId: r.lab_id, level: r.level, state: r.state as InstanceState, reason: r.reason,
    flagHash: r.flag_hash, createdAt: Number(r.created_at), startedAt: num(r.started_at), readyAt: num(r.ready_at),
    expiresAt: num(r.expires_at), lastSeenAt: num(r.last_seen_at), endedAt: num(r.ended_at),
  };
}

export function createInstanceStore(db: DatabaseSync): InstanceStore {
  const insert = db.prepare(`INSERT INTO range_instances (id, user_id, lab_id, level, state, flag_hash, created_at, started_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare(`${SELECT} WHERE id = ?`);
  const active = db.prepare(`${SELECT} WHERE user_id = ? AND state IN ('queued', 'starting', 'running')`);
  const allActive = db.prepare(`${SELECT} WHERE state IN ('queued', 'starting', 'running') ORDER BY created_at, rowid`);
  const byState = db.prepare(`${SELECT} WHERE state = ? ORDER BY created_at, rowid`);
  const live = db.prepare("SELECT COUNT(*) AS n FROM range_instances WHERE state IN ('starting', 'running')");
  const flag = db.prepare(`SELECT level FROM range_instances WHERE user_id = ? AND lab_id = ? AND flag_hash = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1`);
  const latest = db.prepare(`${SELECT} WHERE user_id = ? AND lab_id = ? AND level = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const rows = (stmt: StatementSync, ...args: (string | number)[]) => (stmt.all(...args) as unknown as Row[]).map(toRecord);
  const queued = () => rows(byState, 'queued');

  return Object.freeze({
    insert(r: NewInstance) {
      insert.run(r.id, r.userId, r.labId, r.level, r.state, r.flagHash, r.createdAt, r.startedAt, r.expiresAt);
    },
    get(id: string) { const r = byId.get(id) as Row | undefined; return r ? toRecord(r) : undefined; },
    activeFor(userId: number) { const r = active.get(userId) as Row | undefined; return r ? toRecord(r) : undefined; },
    update(id: string, patch: InstancePatch) {
      const keys = (Object.keys(patch) as (keyof InstancePatch)[]).filter((k) => Object.hasOwn(COLUMNS, k));
      if (keys.length === 0) return;
      db.prepare(`UPDATE range_instances SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k] ?? null), id);
    },
    listActive: () => rows(allActive),
    listByState: (state: InstanceState) => rows(byState, state),
    countLive: () => Number((live.get() as { n: number }).n),
    queued,
    queuePosition: (id: string) => queued().findIndex((r) => r.id === id) + 1,
    levelForFlag(userId: number, labId: string, hash: string, since: number) {
      const r = flag.get(userId, labId, hash, since) as { level: string } | undefined;
      return r && isLevel(r.level) ? r.level : undefined;
    },
    latestFor(userId: number, labId: string, level: Level) {
      const r = latest.get(userId, labId, level) as Row | undefined;
      return r ? toRecord(r) : undefined;
    },
  });
}
