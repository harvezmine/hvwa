// src/core/lab.ts — helpers for challenge routes (the code behind /d/<district>/<slug>).
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
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
  /**
   * An instance unused for longer than this (ms) is dropped; the next request gets a fresh one. Default 26 h:
   * longer than the longest lock/lockout any lab uses (24 h), because expiry IS a reset.
   */
  readonly idleTtlMs?: number;
  /**
   * Most NEW instances created per rolling minute (default 120, see setPerSessionDefaults). Evicting an instance is a reset of that
   * player's lab (counters, locks, secrets), so creating instances must be too slow to flood the LRU out:
   * beyond the limit for() throws NewSessionLimitError (HTTP 429) and nothing is evicted. Infinity disables it.
   */
  readonly maxNewPerMinute?: number;
  /** Called with an instance when it is evicted (LRU) or expires (TTL), e.g. to close a DB. Errors are ignored. */
  readonly dispose?: (value: T) => void;
  /** Clock in ms (injectable for tests). Default Date.now. */
  readonly now?: () => number;
}

/** One lazily created value per (session, level) (see perSession). */
export interface PerSession<T> {
  /** The value for req.sessionId at req.level, created by the factory on first use. */
  for(req: Pick<Request, 'sessionId' | 'level'>): T;
  /** Drop this (session, level)'s instance (calling dispose); the next for() builds a fresh one. */
  reset(req: Pick<Request, 'sessionId' | 'level'>): void;
  /** Instances currently held. */
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_IDLE_TTL_MS = 26 * 60 * 60 * 1000;
const perSessionDefaults = { maxNewPerMinute: 120 };

/**
 * Engine-wide defaults for perSession holders that do not set the option themselves. Read when a
 * holder CHECKS (not when it is created), so module-level holders made at import time follow it.
 * Tests lift the per-holder new-instance limit (tests/support/setup.ts); an explicit
 * `maxNewPerMinute` on a holder always wins. Returns the previous values so a test can restore them.
 */
export function setPerSessionDefaults(d: { readonly maxNewPerMinute?: number }): { maxNewPerMinute: number } {
  const prev = { ...perSessionDefaults };
  if (d.maxNewPerMinute !== undefined) {
    if (d.maxNewPerMinute !== Infinity && (!Number.isInteger(d.maxNewPerMinute) || d.maxNewPerMinute < 1)) {
      throw new Error(`setPerSessionDefaults: maxNewPerMinute must be a positive integer or Infinity (got ${String(d.maxNewPerMinute)})`);
    }
    perSessionDefaults.maxNewPerMinute = d.maxNewPerMinute;
  }
  return prev;
}

/** Thrown by perSession().for() when new instances are being created too fast. The error handler answers 429. */
export class NewSessionLimitError extends Error {
  readonly status = 429;
  constructor() { super('perSession: too many new sessions'); this.name = 'NewSessionLimitError'; }
}

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
  const maxNewOpt = opts.maxNewPerMinute;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`perSession: maxEntries must be a positive integer (got ${String(maxEntries)})`);
  }
  if (typeof idleTtlMs !== 'number' || !(idleTtlMs > 0)) {
    throw new Error(`perSession: idleTtlMs must be a positive number (got ${String(idleTtlMs)})`);
  }
  if (maxNewOpt !== undefined && maxNewOpt !== Infinity && (!Number.isInteger(maxNewOpt) || maxNewOpt < 1)) {
    throw new Error(`perSession: maxNewPerMinute must be a positive integer or Infinity (got ${String(maxNewOpt)})`);
  }
  const created: number[] = []; // creation times within the last minute
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
  const check = ({ sessionId, level }: Pick<Request, 'sessionId' | 'level'>) => {
    if (!isLevel(level)) throw new Error(`perSession: "${String(level)}" is not a level`);
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('perSession: missing sessionId');
  };
  return Object.freeze({
    reset(req: Pick<Request, 'sessionId' | 'level'>): void {
      check(req);
      const key = `${req.level}|${req.sessionId}`;
      const hit = entries.get(key);
      if (hit) drop(key, hit.value);
    },
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
      while (created.length > 0 && t - created[0] >= 60_000) created.shift();
      if (created.length >= (maxNewOpt ?? perSessionDefaults.maxNewPerMinute)) throw new NewSessionLimitError();
      const value = factory(level, sessionId);
      created.push(t);
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

/** The canonical path of the lab being served (/d/<district>/<slug>), set by the engine. Use it for every
 *  lab link and lab cookie path: req.baseUrl echoes the request's spelling (upper-case, trailing slash). */
export function labPath(res: { readonly locals: Record<string, unknown> }): string {
  const p = res.locals.labPath;
  if (typeof p !== 'string') throw new Error('labPath: not a challenge route');
  return p;
}

/**
 * A request header as a string: the value if it arrived once (or as one string), else undefined.
 * Header values are client-written: never trust them as identity (see GK-03).
 */
export function header(req: { readonly headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/**
 * A lab's fixture list (one entry per line, blanks dropped), read lazily once. Resolve the file next to
 * the module with `new URL('./fixtures/x.txt', import.meta.url)`; copy-assets ships fixtures into dist/.
 */
export function fixtureLines(url: URL): () => readonly string[] {
  let lines: readonly string[] | undefined;
  return () => (lines ??= Object.freeze(readFileSync(url, 'utf8').split(/\r?\n/).filter((l) => l !== '')));
}

/** Serve a fixture list from a lab route as text/plain, one entry per line. */
export function sendLines(res: Pick<Response, 'type'>, lines: readonly string[]): void {
  res.type('text/plain').send(`${lines.join('\n')}\n`);
}
