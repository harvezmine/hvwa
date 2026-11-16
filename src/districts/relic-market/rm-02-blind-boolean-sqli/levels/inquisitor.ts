import type { ChallengeDb } from '../../../../core/challenge-db.js';

// INQUISITOR — real defense, subtly wrong: the SKU the player types is a bound parameter. The region is still
// concatenated, because "the app set that cookie itself". A cookie is a request header the client writes, so it is
// input like any other.
export const region = (raw: string): string => raw;

export function inStock(db: ChallengeDb, sku: string, region: string): boolean {
  const row = db.prepare(`SELECT qty FROM stock WHERE sku = ? AND region = '${region}'`).get(sku);
  return row !== undefined && Number(row.qty) > 0;
}
