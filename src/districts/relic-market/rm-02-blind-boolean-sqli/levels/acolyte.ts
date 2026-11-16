import type { ChallengeDb } from '../../../../core/challenge-db.js';

// ACOLYTE — no defense: the SKU and the region (a cookie the app set itself) are concatenated straight into the SQL.
// Blind: the page only ever says "In stock" or "Not available." (a database error is "Not available." too).
export const region = (raw: string): string => raw;

export function inStock(db: ChallengeDb, sku: string, region: string): boolean {
  const row = db.prepare(`SELECT qty FROM stock WHERE sku = '${sku}' AND region = '${region}'`).get();
  return row !== undefined && Number(row.qty) > 0;
}
