import type { ChallengeDb } from '../../../../core/challenge-db.js';

// TEMPLAR — naive filter: input containing the words AND or OR, a comment (-- or #) or a semicolon is refused, in the
// SKU and in the region alike. Conditional expressions (IIF, CASE) and string concatenation (||) are not on the list,
// and the Acolyte SQL follows.
export const region = (raw: string): string => raw;

const BLACKLIST = /\b(and|or)\b|--|#|;/i;

export function inStock(db: ChallengeDb, sku: string, region: string): boolean | string {
  if (BLACKLIST.test(sku) || BLACKLIST.test(region)) return 'Invalid SKU.';
  const row = db.prepare(`SELECT qty FROM stock WHERE sku = '${sku}' AND region = '${region}'`).get();
  return row !== undefined && Number(row.qty) > 0;
}
