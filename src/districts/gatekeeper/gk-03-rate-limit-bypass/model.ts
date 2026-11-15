// model.ts — GK-03's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

export interface Account { username: string; password: string; role: 'admin' | 'user' }
export interface Creds { username: string; password: string }

/** Attempts counted in the current fixed window for one limiter key. */
export interface Bucket { count: number; windowStart: number }

/** One player's lab at one level. */
export interface LabState {
  /** The citadel admin's password: a random pick from the served leaked list. */
  readonly adminPassword: string;
  /** Limiter buckets, keyed however the level keys them. */
  readonly buckets: Map<string, Bucket>;
  /** The clock (ms); a test seam so the window can expire without waiting. */
  now: () => number;
}

/** What the route hands a level for one login request. */
export interface Attempt {
  /** The parsed request body (form object, JSON object or JSON array): untrusted, any shape. */
  readonly body: unknown;
  /** X-Forwarded-For exactly as the client sent it. */
  readonly forwardedFor: string | undefined;
  /** X-Real-IP exactly as the client sent it. */
  readonly realIp: string | undefined;
  /** The TCP peer address: the only value the client cannot choose. */
  readonly socketAddress: string;
}

/** A login attempt's result: the account that signed in, or the message to show. */
export type Outcome =
  | { ok: true; account: Account }
  | { ok: false; message: string };

/** What every levels/<level>.ts exports (checked by byLevel<LimitLevel> in challenge.ts). */
export interface LimitLevel {
  login(state: LabState, attempt: Attempt): Outcome;
}

/** The limiter: at most MAX attempts per key per fixed window. */
export const LIMIT = Object.freeze({ max: 5, windowMs: 60_000 });

/** The player's own (unprivileged) account, shown on the lab page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });
export const ADMIN_NAME = 'citadel_admin';

/** Both accounts of this lab. */
export function accounts(state: LabState): readonly Account[] {
  return [
    { username: ADMIN_NAME, password: state.adminPassword, role: 'admin' },
    { username: PLAYER.username, password: PLAYER.password, role: 'user' },
  ];
}

/** A credentials pair from any untrusted value: missing or non-string fields are ''. */
export function readCreds(value: unknown): Creds {
  const o = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const str = (k: string): string => (Object.hasOwn(o, k) && typeof o[k] === 'string' ? (o[k] as string) : '');
  return { username: str('username'), password: str('password') };
}

const MAX_BUCKETS = 2000;
/** True while `key` has used up its attempts in the current window. */
export function isLimited(state: LabState, key: string, max: number = LIMIT.max): boolean {
  const b = state.buckets.get(key);
  return b !== undefined && state.now() - b.windowStart < LIMIT.windowMs && b.count >= max;
}
/** Count one attempt against `key` (starts a new window if the last one ended). Bounded memory. */
export function record(state: LabState, key: string): void {
  const now = state.now();
  const b = state.buckets.get(key);
  if (b && now - b.windowStart < LIMIT.windowMs) { b.count += 1; return; }
  state.buckets.delete(key);
  state.buckets.set(key, { count: 1, windowStart: now });
  if (state.buckets.size > MAX_BUCKETS) {
    for (const [k, v] of state.buckets) if (now - v.windowStart >= LIMIT.windowMs) state.buckets.delete(k);
    while (state.buckets.size > MAX_BUCKETS) state.buckets.delete(state.buckets.keys().next().value as string);
  }
}

// The leaked list the lab serves at ./leaked.txt (and the admin password is drawn from).
const LEAKED_URL = new URL('./fixtures/leaked.txt', import.meta.url);
let leaked: readonly string[] | undefined;
/** The served leaked-password list, one entry per line. */
export function leakedList(): readonly string[] {
  leaked ??= Object.freeze(readFileSync(LEAKED_URL, 'utf8').split(/\r?\n/).filter((w) => w !== ''));
  return leaked;
}

// Per player AND per level: the limiter buckets and the admin password are state a player
// changes or learns. (Every player connects from the same loopback address, so a shared
// limiter would let one player lock out another.)
const labs = perSession((): LabState => ({
  adminPassword: leakedList()[randomInt(leakedList().length)],
  buckets: new Map(),
  now: Date.now,
}));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Test seam: the real citadel_admin password of session `sessionId` at `level`. */
export function adminPassword(sessionId: string, level: Level): string {
  return labState(sessionId, level).adminPassword;
}
