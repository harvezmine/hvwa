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

/**
 * Run a (synchronous) challenge-DB call. On success `{ ok: true, value }`. On
 * a throw, `{ ok: false, message }`: below Divine the message is
 * `Database error: <err.message>` (error-based learning, CWE-209 on purpose);
 * at Divine it is the generic DIVINE_DB_ERROR. Put ONLY the DB call inside —
 * never flagFor() or rendering, whose errors must reach the error handler.
 */
export function tryDb<T>(req: Pick<Request, 'level'>, fn: () => T): DbResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (req.level === 'divine') return { ok: false, message: DIVINE_DB_ERROR };
    return { ok: false, message: `Database error: ${err instanceof Error ? err.message : String(err)}` };
  }
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
