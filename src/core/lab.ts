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
  /**
   * Most (session, level) instances kept; beyond it the least recently used is evicted. Default 5000. A holder
   * capped by what it keeps (capPerSessionHolder: simulated-victim state, core/sim/world.ts) also shares one
   * process-wide budget with every other capped holder.
   */
  readonly maxEntries?: number;
  /**
   * An instance unused for longer than this (ms) is dropped; the next request gets a fresh one. Default 26 h:
   * longer than the longest lock/lockout any lab uses (24 h), because expiry IS a reset.
   */
  readonly idleTtlMs?: number;
  /**
   * Most NEW instances created per rolling minute (default 120, see setPerSessionDefaults; or the cap of what the
   * factory builds, see capPerSessionHolder). Evicting an instance is a reset of that
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
 * `maxNewPerMinute` on a holder always wins. Infinity lifts capped holders (capPerSessionHolder) too;
 * a finite default never raises one above its cap. Returns the previous values so a test can restore them.
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

/** What a kind of store asks of the perSession holder that keeps it (see capPerSessionHolder). */
export interface HolderCaps {
  /** Most new instances a rolling minute: the holder's default, and the most it may ask for. */
  readonly maxNewPerMinute: number;
  /**
   * What one such store can hold at worst, in bytes: its measured worst case plus a margin (core/sim/limits.ts,
   * core/simfs.ts, each checked by a memory spec). An instance weighs every capped store its factory built or used,
   * and all capped instances share ONE process-wide byte budget, CAPPED_BUDGET_BYTES.
   */
  readonly weight: number;
}

/**
 * The process-wide byte budget of capped instances (simulated-victim worlds, simulated file systems...): every lab
 * and level together, weighed by their stores' worst cases. 96 MiB of the container's 512 MB (controller decision).
 */
export const CAPPED_BUDGET_BYTES = 96 * 1024 * 1024;

/** One running perSession factory: its holder's own options, and what the capped stores it built or used ask. */
interface FactoryFrame {
  readonly asked: { readonly maxNewPerMinute?: number };
  /** The tightest rate of those stores (undefined: none built or used). */
  maxNewPerMinute?: number;
  /** Their weights, summed: what the instance this factory builds weighs in the budget. */
  weight: number;
  /** The first of them (for errors), e.g. 'simWorld'. */
  what?: string;
}

// The process-wide budget: every capped instance, least recently used first, with its weight and the function that
// drops it from its holder (an eviction is a reset of that instance, as for a holder's own LRU).
const cappedEntries = new Map<object, { readonly weight: number; readonly drop: () => void }>();
let cappedBytes = 0;
let budgetOverride: number | undefined;
const budgetBytes = (): number => budgetOverride ?? CAPPED_BUDGET_BYTES;

/**
 * Test seam: set the process-wide byte budget of capped instances (a positive integer), or undefined for
 * CAPPED_BUDGET_BYTES. It applies from the next instance created. Returns the previous setting, so a test can
 * restore it.
 */
export function setCappedBudget(bytes: number | undefined): number | undefined {
  if (bytes !== undefined && (!Number.isInteger(bytes) || bytes < 1)) {
    throw new Error(`setCappedBudget: the budget must be a positive integer of bytes or undefined (got ${String(bytes)})`);
  }
  const prev = budgetOverride;
  budgetOverride = bytes;
  return prev;
}

/** Test seam: the capped instances held process-wide, the bytes they weigh, and the budget. */
export function cappedBudgetUsage(): { readonly bytes: number; readonly instances: number; readonly budget: number } {
  return { bytes: cappedBytes, instances: cappedEntries.size, budget: budgetBytes() };
}

// The perSession factories running right now, innermost last (factories are synchronous; nesting is allowed).
const frames: FactoryFrame[] = [];

/**
 * Whether code is running inside a perSession() factory. Per-player stores (core/sim/world.ts: inbox, attacker log,
 * the victim's browser) check it, so they can only be made as part of one player's lab state, never at module level.
 */
export function insidePerSessionFactory(): boolean {
  return frames.length > 0;
}

/**
 * Cap the holder of EVERY running factory (each keeps the store, directly or through a nested holder), adding the
 * store's weight to each. A store kept by an outer and an inner holder counts in both: conservative, never under.
 */
function capFrames(what: string, caps: HolderCaps): void {
  for (const frame of frames) {
    const { maxNewPerMinute } = frame.asked;
    if (maxNewPerMinute !== undefined && maxNewPerMinute > caps.maxNewPerMinute) {
      throw new Error(`${what}: a perSession holder that keeps it may create at most ${caps.maxNewPerMinute} new instances a minute (this one asks for maxNewPerMinute: ${maxNewPerMinute})`);
    }
  }
  for (const frame of frames) {
    frame.maxNewPerMinute = Math.min(frame.maxNewPerMinute ?? Infinity, caps.maxNewPerMinute);
    frame.weight += caps.weight;
    frame.what ??= what;
  }
}

/**
 * For stores whose instances are large (core/sim/world.ts: inbox, attacker log, visits, the victim's browser;
 * core/simfs.ts): called while a perSession factory builds one, it caps the holder running that factory, and every
 * holder whose factory is running around it (an outer holder that keeps the store through a nested holder keeps it
 * alive too). A capped holder used inside another holder's factory later, even for an instance it already has, caps
 * that one too, with that instance's weight.
 *
 * - The instance joins ONE process-wide byte budget shared by every capped holder (CAPPED_BUDGET_BYTES, every lab and
 *   level together), weighing the sum of the `caps.weight` of every store its factory built or used. Creating one
 *   that does not fit evicts the least recently used capped instances, whichever holder keeps them, as many as it
 *   takes (each a reset of that instance; the new one is never refused). Memory stays bounded however many labs keep
 *   such state; a reset, an idle-TTL expiry or the holder's own `maxEntries` gives an instance's bytes back.
 * - The holder creates at most `caps.maxNewPerMinute` instances a minute, by default and as a ceiling: a holder whose
 *   own options ask for more fails right here, at its first factory run, with an error naming `what`, and keeps
 *   nothing.
 *
 * Throws outside a factory, or for a weight or rate that is not a positive integer.
 */
export function capPerSessionHolder(what: string, caps: HolderCaps): void {
  if (frames.length === 0) throw new Error(`${what}: create it inside a perSession() factory`);
  if (!Number.isInteger(caps.weight) || caps.weight < 1) throw new Error(`${what}: weight must be a positive integer of bytes (got ${String(caps.weight)})`);
  if (!Number.isInteger(caps.maxNewPerMinute) || caps.maxNewPerMinute < 1) {
    throw new Error(`${what}: maxNewPerMinute must be a positive integer (got ${String(caps.maxNewPerMinute)})`);
  }
  capFrames(what, caps);
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
  /** `weight`: the bytes it counts in the process-wide budget (0: it keeps no capped store, and is not in it). */
  type Entry = { value: T; usedAt: number; readonly weight: number };
  const entries = new Map<string, Entry>();
  const asked = { maxNewPerMinute: maxNewOpt };
  let rateCap: number | undefined; // set by the first factory run that builds or uses a capped store (capPerSessionHolder)
  let capsWhat = ''; // what set it (for errors)
  const rateLimit = (): number => {
    if (maxNewOpt !== undefined) return maxNewOpt; // never above a cap: capPerSessionHolder refused it
    const d = perSessionDefaults.maxNewPerMinute;
    return rateCap === undefined || d === Infinity ? d : Math.min(d, rateCap);
  };
  const drop = (key: string, e: Entry) => {
    if (entries.get(key) === e) entries.delete(key);
    const inBudget = cappedEntries.get(e);
    if (inBudget !== undefined) {
      cappedEntries.delete(e);
      cappedBytes -= inBudget.weight; // a reset, an expiry or an eviction gives the bytes back
    }
    try { dispose?.(e.value); } catch { /* a failing dispose never breaks a request */ }
  };
  const sweep = (t: number) => {
    for (const [key, e] of entries) {
      if (t - e.usedAt <= idleTtlMs) break;
      drop(key, e);
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
      if (hit) drop(key, hit);
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
        const inBudget = cappedEntries.get(hit);
        if (inBudget !== undefined) { cappedEntries.delete(hit); cappedEntries.set(hit, inBudget); } // the newest in the budget too
        // Another holder's factory keeps it: that holder is capped too, and its instance weighs this one as well.
        if (rateCap !== undefined && frames.length > 0) capFrames(capsWhat, { maxNewPerMinute: rateCap, weight: hit.weight });
        return hit.value;
      }
      while (created.length > 0 && t - created[0] >= 60_000) created.shift();
      if (created.length >= rateLimit()) throw new NewSessionLimitError();
      let value: T;
      const frame: FactoryFrame = { asked, weight: 0 };
      frames.push(frame);
      try { value = factory(level, sessionId); } finally { frames.pop(); }
      if (frame.maxNewPerMinute !== undefined) {
        rateCap = Math.min(rateCap ?? Infinity, frame.maxNewPerMinute);
        capsWhat ||= frame.what ?? '';
      } else if (rateCap !== undefined && frames.length > 0) {
        // Built nothing capped this time, inside another holder's factory: still pass this holder's rate cap out.
        capFrames(capsWhat, { maxNewPerMinute: rateCap, weight: 0 });
      }
      created.push(t);
      const e: Entry = { value, usedAt: t, weight: frame.weight };
      if (e.weight > 0) {
        // The least recently used capped instances go (in any holder) until this one fits; it is never refused.
        while (cappedEntries.size > 0 && cappedBytes + e.weight > budgetBytes()) {
          (cappedEntries.values().next().value as { drop: () => void }).drop();
        }
        cappedEntries.set(e, { weight: e.weight, drop: () => drop(key, e) });
        cappedBytes += e.weight;
      }
      entries.set(key, e);
      while (entries.size > maxEntries) {
        const [oldKey, old] = entries.entries().next().value as [string, Entry];
        drop(oldKey, old);
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
