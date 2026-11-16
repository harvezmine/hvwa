// model.ts — RM-03's data and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { MAX_WAIT_MS } from '../_shared/clock.js';

/** The order the page says is yours. */
export const LAST_ORDER = 'RM-1001';

/** What every levels/<level>.ts exports (checked by byLevel<TrackLevel> in challenge.ts). */
export interface TrackLevel {
  /**
   * Look the order up (the answer never depends on what is found: the customer is emailed). Returns a validation
   * message to refuse the input, otherwise nothing. Database errors are thrown, and hidden (blind).
   */
  lookup(db: ChallengeDb, orderNo: string): void | string;
}

const SCHEMA = `
  CREATE TABLE orders (order_no TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, pin TEXT NOT NULL)`;

const ORDERS: readonly (readonly [string, string, string])[] = [
  ['RM-1001', 'pilgrim@relic-market.test', 'shipped'],
  ['RM-1002', 'brother.tobias@relic-market.test', 'packing'],
  ['RM-1003', 'sister.agnes@relic-market.test', 'delivered'],
  ['RM-1004', 'verger@relic-market.test', 'awaiting payment'],
  ['RM-1005', 'prior@relic-market.test', 'cancelled'],
];

/** The simulated delay one query has asked for so far, in ms (see sleep() below). */
interface Delay { ms: number }

// One orders DB per level, each with its own random vault PIN: a PIN read out at Acolyte must not redeem at Templar,
// Inquisitor or Divine. Read-only: an injected SELECT cannot mutate (and prepare() runs one statement).
const labs = perLevel(() => {
  const pin = randomBytes(3).toString('hex');
  const delay: Delay = { ms: 0 };
  const db = challengeDb(SCHEMA, (raw) => {
    const o = raw.prepare('INSERT INTO orders (order_no, email, status) VALUES (?, ?, ?)');
    for (const r of ORDERS) o.run(...r);
    raw.prepare('INSERT INTO vault (pin) VALUES (?)').run(pin);
    // A MySQL-style sleep(seconds) the shop "provides". It NEVER blocks (node:sqlite is synchronous, a real sleep would
    // freeze the whole server): it only adds to this query's delay, and the route then waits that long on the
    // Relic Market clock after the query has run. Plain numbers (or numeric text) only, 0..5 s, at most 5 s a query.
    // The seed must never re-register randomblob() or zeroblob(): the engine caps them on every challenge DB.
    raw.function('sleep', { directOnly: true }, (seconds) => {
      const n = typeof seconds === 'number' ? seconds : typeof seconds === 'string' ? Number(seconds) : 0;
      const ms = Number.isNaN(n) ? 0 : Math.min(Math.max(n, 0), 5) * 1000;
      delay.ms = Math.min(delay.ms + ms, MAX_WAIT_MS);
      return 0;
    });
  });
  return { db, pin, delay };
});

/** The orders DB serving `level` (test seam too). */
export function ordersDb(level: Level): ChallengeDb {
  return labs.for(level).db;
}

/** Test seam: the real vault PIN at `level` (6 hex characters). */
export function vaultPin(level: Level): string {
  return labs.for(level).pin;
}

/**
 * Run one synchronous query and report how long it asked the shop to wait. The accumulator is reset before the query
 * and again in a `finally`, so a query that throws (or a stale remainder) never leaks into the next request: node:sqlite
 * is synchronous, so no other request can run in between. The caller then awaits that long on the shop clock.
 */
export function measured<T>(level: Level, run: () => T): { readonly value: T; readonly delayMs: number } {
  const { delay } = labs.for(level);
  delay.ms = 0;
  try {
    const value = run();
    return { value, delayMs: delay.ms };
  } finally {
    delay.ms = 0;
  }
}
