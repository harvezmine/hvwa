// src/core/lab.ts — helpers for challenge routes (the code behind /d/<district>/<slug>).
import type { Request } from 'express';
import { LEVELS, isLevel, type Level } from './levels.js';

/** One lazily created value per level (see perLevel). */
export interface PerLevel<T> {
  /** The value for `level`, created by the factory on first use and cached. */
  for(level: Level): T;
}

/**
 * Per-level isolation. `factory(level)` runs at most once per level, the first
 * time that level is asked for. Use it for anything a player could extract at
 * one level and replay at another (a challenge DB, a random password, a key):
 *
 *   const users = perLevel(() => challengeDb(SCHEMA, seed));
 *   users.for(req.level).prepare(...)
 */
export function perLevel<T>(factory: (level: Level) => T): PerLevel<T> {
  const cache = new Map<Level, T>();
  return Object.freeze({
    for(level: Level): T {
      if (!isLevel(level)) throw new Error(`perLevel: "${String(level)}" is not a level`);
      if (!cache.has(level)) cache.set(level, factory(level));
      return cache.get(level) as T;
    },
  });
}

export interface PerSessionOptions<T = unknown> {
  /** Most (session, level) instances kept; beyond it the least recently used is evicted. Default 5000. */
  readonly maxEntries?: number;
  /** An instance unused for longer than this (ms) is dropped; the next request gets a fresh one. Default 2 h. */
  readonly idleTtlMs?: number;
  /** Called with an instance when it is evicted (LRU) or expires (TTL), e.g. to close a DB. Errors are ignored. */
  readonly dispose?: (value: T) => void;
  /** Clock in ms (injectable for tests). Default Date.now. */
  readonly now?: () => number;
}

/** One lazily created value per (session, level) (see perSession). */
export interface PerSession<T> {
  /** The value for req.sessionId at req.level, created by the factory on first use. */
  for(req: Pick<Request, 'sessionId' | 'level'>): T;
  /** Instances currently held. */
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Per-player isolation for labs whose exploit MUTATES state (balances,
 * roles, lockout counters, OTPs, stored payloads): `factory(level, sessionId)`
 * runs the first time a session uses a level, so one player's exploit never
 * changes another player's lab, and levels are isolated too (no perLevel on
 * top). Memory is bounded: least-recently-used eviction beyond `maxEntries`,
 * and instances idle longer than `idleTtlMs` are dropped. A dropped instance
 * is rebuilt fresh, so labs must tolerate a reset. `dispose(value)` (optional)
 * is called on either removal; errors in it are caught and ignored.
 *
 *   const shop = perSession(() => challengeDb(SCHEMA, seed));
 *   shop.for(req).prepare(...)
 */
export function perSession<T>(
  factory: (level: Level, sessionId: string) => T, opts: PerSessionOptions<T> = {},
): PerSession<T> {
  const { maxEntries = DEFAULT_MAX_ENTRIES, idleTtlMs = DEFAULT_IDLE_TTL_MS, now = Date.now, dispose } = opts;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`perSession: maxEntries must be a positive integer (got ${String(maxEntries)})`);
  }
  if (typeof idleTtlMs !== 'number' || !(idleTtlMs > 0)) {
    throw new Error(`perSession: idleTtlMs must be a positive number (got ${String(idleTtlMs)})`);
  }
  // Map order = least recently used first (every use re-inserts at the end).
  const entries = new Map<string, { value: T; usedAt: number }>();
  const drop = (key: string, value: T) => {
    entries.delete(key);
    try { dispose?.(value); } catch { /* a failing dispose never breaks a request */ }
  };
  const sweep = (t: number) => {
    for (const [key, e] of entries) {
      if (t - e.usedAt <= idleTtlMs) break;
      drop(key, e.value);
    }
  };
  return Object.freeze({
    for(req: Pick<Request, 'sessionId' | 'level'>): T {
      const { sessionId, level } = req;
      if (!isLevel(level)) throw new Error(`perSession: "${String(level)}" is not a level`);
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('perSession: missing sessionId');
      const t = now();
      sweep(t);
      const key = `${level}|${sessionId}`;
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        hit.usedAt = t;
        entries.set(key, hit);
        return hit.value;
      }
      const value = factory(level, sessionId);
      entries.set(key, { value, usedAt: t });
      if (entries.size > maxEntries) {
        const [oldKey, old] = entries.entries().next().value as [string, { value: T }];
        drop(oldKey, old.value);
      }
      return value;
    },
    get size(): number { return entries.size; },
  });
}

/** A challenge's level modules, keyed by level (see byLevel). */
export interface ByLevel<M> {
  /** The implemented levels, in rank order: pass to defineChallenge({ levels }). */
  readonly levels: readonly Level[];
  /** The module for `level`; throws if that level is not implemented. */
  for(level: Level): M;
}

/**
 * Gather a challenge's `levels/<level>.ts` modules. Give the shared module
 * type explicitly so every level is checked against it:
 *
 *   import * as acolyte from './levels/acolyte.js'; // ...
 *   const impl = byLevel<LoginLevel>({ acolyte, templar, inquisitor, divine });
 *   defineChallenge({ levels: impl.levels, ... });
 *   impl.for(req.level).findUser(...)
 *
 * Omit the levels a challenge does not implement. M is never inferred (a
 * forgotten <M> makes for() return unknown), and req.level on a challenge
 * route is always one of `levels`, so for() needs no `!` or Partial.
 */
export function byLevel<M>(modules: { readonly [L in Level]?: NoInfer<M> }): ByLevel<M> {
  for (const key of Object.keys(modules)) {
    if (!isLevel(key)) throw new Error(`byLevel: unknown level "${key}"`);
  }
  const table = new Map<Level, M>();
  for (const level of LEVELS) {
    const m = Object.hasOwn(modules, level) ? modules[level] : undefined;
    if (m !== undefined) table.set(level, m);
  }
  if (table.size === 0) throw new Error('byLevel: needs at least one level');
  return Object.freeze({
    levels: Object.freeze([...table.keys()]),
    for(level: Level): M {
      const m = table.get(level);
      if (m === undefined) throw new Error(`byLevel: level "${String(level)}" is not implemented`);
      return m;
    },
  });
}

/** What Divine shows instead of a database error message. */
export const DIVINE_DB_ERROR = 'Invalid request.';

export type DbResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return (typeof x === 'object' || typeof x === 'function') && x !== null
    && typeof (x as { then?: unknown }).then === 'function';
}

/**
 * Run a synchronous challenge-DB (or parser) call. On success `{ ok: true,
 * value }`. On a throw, `{ ok: false, message }`: below Divine the message is
 * `<label>: <err.message>` (error-based learning, CWE-209 on purpose; label
 * defaults to 'Database error', e.g. 'Parser error' for XML/YAML labs); at
 * Divine it is the generic DIVINE_DB_ERROR. Put ONLY that call inside, never
 * flagFor() or rendering, whose errors must reach the error handler.
 *
 * `fn` must be synchronous (node:sqlite is). A thenable result throws: an
 * async rejection would otherwise escape the catch and bypass the Divine rule.
 */
export function tryDb<T>(req: Pick<Request, 'level'>, fn: () => T, label = 'Database error'): DbResult<T> {
  let value: T;
  try {
    value = fn();
  } catch (err) {
    if (req.level === 'divine') return { ok: false, message: DIVINE_DB_ERROR };
    return { ok: false, message: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (isThenable(value)) {
    value.then(undefined, () => {}); // never leave its rejection unhandled
    throw new Error('tryDb: fn returned a Promise; tryDb is synchronous (await outside it, or add tryDbAsync)');
  }
  return { ok: true, value };
}

/**
 * A request body field as a string: the value if it is an own string
 * property, otherwise ''. A JSON body such as {"username":{"toString":1}} or
 * an extended-urlencoded `username[x]=1` gives '' instead of a 500.
 */
export function field(req: { readonly body?: unknown }, name: string): string {
  const body = req.body;
  if (body === null || typeof body !== 'object' || !Object.hasOwn(body, name)) return '';
  const value: unknown = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}
