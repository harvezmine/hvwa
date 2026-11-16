// model.ts — RM-02's data and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

/** The regions the stock checker knows, and the default one. The setter writes only these. */
export const REGIONS = ['eu', 'us', 'apac'] as const;
export const DEFAULT_REGION = 'eu';

/** The cookie holding the player's region at `level` (a preference, not HttpOnly; one name per level). */
export const regionCookie = (level: Level): string => `relic_region_${level}`;

/** What every levels/<level>.ts exports (checked by byLevel<StockLevel> in challenge.ts). */
export interface StockLevel {
  /** The region this level uses for a region cookie value (shown on the page and handed to inStock). */
  region(raw: string): string;
  /** Whether `sku` has stock in `region`: a boolean, or a validation message. Database errors are thrown, and hidden (blind). */
  inStock(db: ChallengeDb, sku: string, region: string): boolean | string;
}

/** The product list the page shows, so players know an in-stock SKU. */
export const PRODUCTS: readonly (readonly [string, string])[] = [
  ['RELIC-CHALICE', 'Silver Chalice'], ['RELIC-LANTERN', 'Pilgrim Lantern'], ['RELIC-ICON', 'Gilded Icon of Saint Aurel'],
];

const SCHEMA = `
  CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE stock (sku TEXT NOT NULL, region TEXT NOT NULL, qty INTEGER NOT NULL);
  CREATE TABLE staff_codes (id INTEGER PRIMARY KEY, holder TEXT NOT NULL, code TEXT NOT NULL)`;

// One stock DB per level, each with its own random staff code: a code read out at Acolyte must not redeem at Templar,
// Inquisitor or Divine. Read-only: an injected SELECT cannot mutate (and prepare() runs one statement).
const stocks = perLevel(() => {
  const code = randomBytes(4).toString('hex');
  const db = challengeDb(SCHEMA, (raw) => {
    const p = raw.prepare('INSERT INTO products (sku, name) VALUES (?, ?)');
    for (const [sku, name] of PRODUCTS) p.run(sku, name);
    const s = raw.prepare('INSERT INTO stock (sku, region, qty) VALUES (?, ?, ?)');
    s.run('RELIC-CHALICE', 'eu', 4);
    s.run('RELIC-CHALICE', 'us', 2);
    s.run('RELIC-LANTERN', 'eu', 0);
    s.run('RELIC-LANTERN', 'us', 0);
    s.run('RELIC-LANTERN', 'apac', 0);
    s.run('RELIC-ICON', 'apac', 1);
    raw.prepare('INSERT INTO staff_codes (holder, code) VALUES (?, ?)').run('relic_admin', code);
  });
  return { db, code };
});

/** The stock DB serving `level` (test seam too). */
export function stockDb(level: Level): ChallengeDb {
  return stocks.for(level).db;
}

/** Test seam: the real staff code at `level` (8 hex characters). */
export function staffCode(level: Level): string {
  return stocks.for(level).code;
}
