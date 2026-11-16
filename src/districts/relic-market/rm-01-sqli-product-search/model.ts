// model.ts — RM-01's data and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { clip } from '../_shared/sql.js';
import { formatMoney } from '../_shared/shop.js';

/** The most rows a search ever shows (platform safety, not the lesson): the level reads with firstRows, never a LIMIT. */
export const MAX_ROWS = 50;
/** What an empty "max price" field means. */
export const NO_MAX = '1000000';

/** One result row as a level returns it (the four columns of the search SELECT; an injected UNION must match them). */
export type Row = Record<string, unknown>;

/** What every levels/<level>.ts exports (checked by byLevel<SearchLevel> in challenge.ts). */
export interface SearchLevel {
  /** The matching rows, or a validation message (shown as the lab message). Database errors are thrown (tryDb). */
  search(db: ChallengeDb, q: string, max: string): Row[] | string;
}

const SCHEMA = `
  CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    price_cents INTEGER NOT NULL, description TEXT NOT NULL, hidden INTEGER NOT NULL);
  CREATE TABLE secrets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL)`;

const RELICS: readonly (readonly [string, string, string, number, string, number])[] = [
  ['RELIC-CHALICE', 'Silver Chalice', 'vessels', 18500, "A pilgrim's cup, hammered silver, slightly dented.", 0],
  ['RELIC-LANTERN', 'Pilgrim Lantern', 'lighting', 4200, 'Tin lantern that survived three crossings.', 0],
  ['RELIC-ICON', 'Gilded Icon of Saint Aurel', 'icons', 64000, 'Egg tempera on cedar, gold leaf.', 0],
  ['RELIC-ROSARY', 'Bone Rosary', 'beads', 3900, 'Fifty-nine beads and a worn cross.', 0],
  ['RELIC-CANDLE', 'Beeswax Votive Candle', 'lighting', 250, 'Burns for nine hours.', 0],
  ['RELIC-SEAL', 'Wax Seal of the Prior', 'seals', 1200, 'Impression of a chapter seal, 14th century.', 0],
  ['RELIC-BELL', 'Hand Bell of Saint Odo', 'bells', 9800, 'Bronze, rings a clear G.', 0],
  ['RELIC-CENSER', 'Brass Censer', 'vessels', 7600, 'Swings on three chains.', 0],
  ['RELIC-SCROLL', 'Vellum Prayer Scroll', 'scrolls', 2100, 'Copied by hand, one corner missing.', 0],
  ['RELIC-CROSS', 'Pectoral Cross', 'jewellery', 31000, 'Garnets set in oxidised silver.', 0],
  ['RELIC-STAFF', 'Pilgrim Staff', 'tools', 1500, 'Ash wood with an iron ferrule.', 0],
  ['RELIC-VEIL', 'Veil of the Sisters', 'textiles', 5400, 'Linen, embroidered hem.', 0],
  ['RELIC-HIDDEN-REL', 'Reliquary Fragment (not for sale)', 'reserved', 990000, 'Held back for the vault.', 1],
  ['RELIC-HIDDEN-MAP', 'Cellarer Map (not for sale)', 'reserved', 880000, 'Held back for the vault.', 1],
];

// One catalog DB per level, each with its own random vault key: a key dumped by a UNION at Acolyte must not count at
// Templar, Inquisitor or Divine. Read-only: an injected SELECT cannot mutate (and prepare() runs one statement).
const catalogs = perLevel(() => {
  const vaultKey = randomBytes(12).toString('hex');
  const db = challengeDb(SCHEMA, (raw) => {
    const p = raw.prepare('INSERT INTO products (sku, name, category, price_cents, description, hidden) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of RELICS) p.run(...r);
    const s = raw.prepare('INSERT INTO secrets (name, value) VALUES (?, ?)');
    s.run('vault_key', vaultKey);
    s.run('backup_note', 'rotate quarterly');
  });
  return { db, vaultKey };
});

/** The catalog DB serving `level` (test seam too). */
export function catalogDb(level: Level): ChallengeDb {
  return catalogs.for(level).db;
}

/** Test seam: the shop's real vault key at `level`. */
export function vaultKey(level: Level): string {
  return catalogs.for(level).vaultKey;
}

/** A result row as the page shows it: four display cells, each at most 200 characters. The price is money when it is one. */
export function cellsOf(row: Row): string[] {
  return Object.values(row).slice(0, 4).map((v, i) => (i === 2 && typeof v === 'number' && Number.isSafeInteger(v) ? formatMoney(v) : clip(v)));
}

/** The oracle: the vault key is a rendered result cell. The echoed search term is not (it is never a cell). */
export function proves(cells: readonly (readonly string[])[], level: Level): boolean {
  const key = vaultKey(level);
  return cells.some((row) => row.some((cell) => cell.includes(key)));
}
